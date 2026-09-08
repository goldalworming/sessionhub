//! Arranging a hostname for a local address, through the Cloudflare API.
//!
//! The tunnel this machine is reached by is remotely managed — `cloudflared
//! tunnel run --token …`, with no config file on this side — so its ingress can
//! only be changed where it lives, which is Cloudflare's own API.
//!
//! HTTPS is done by shelling out to `curl`, the same way `update.rs` talks to
//! GitHub and for the same reason: one more route to one more host does not
//! justify a TLS stack. The API token never appears in an argument, though —
//! anything on this machine can read a process table — so it rides in a
//! `--config` file that is written, used and deleted.
//!
//! None of this is required. Without a token, `tunnel.rs` gives each address a
//! throwaway trycloudflare hostname instead; what that costs is a name that
//! changes every time.

use std::path::PathBuf;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::config::{Cloudflare, Forward};

const API: &str = "https://api.cloudflare.com/client/v4";

/// A thing the token can reach, named so it can be chosen rather than typed.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Named {
    pub id: String,
    pub name: String,
}

/// What a token turned out to reach.
#[derive(Debug, Clone, Default)]
pub struct Found {
    pub account: Named,
    pub zones: Vec<Named>,
    pub tunnels: Vec<Named>,
}

/// Follow a token to the account, the domains and the tunnels behind it.
///
/// Nothing is written here; this only looks. Which domain and which tunnel to
/// use is then a choice made from a list rather than a string typed from
/// memory — and a wrong token is found out before any hostname exists.
pub fn discover(api_token: &str) -> Result<Found, String> {
    let mut found = Found::default();

    // The domains first, and the account read off one of them.
    //
    // `/accounts` is the obvious place to ask for the account and it is the
    // wrong one: enumerating accounts needs a permission of its own, and a
    // token scoped to Cloudflare Tunnel and DNS does not carry it. It does not
    // fail either — it answers `success` with an empty list, which reads as
    // "you have no account" when it means "you may not list them". Every zone
    // names the account it belongs to, and reading zones is something this
    // token can do by definition, or it could not edit their DNS.
    let zones = call(api_token, "GET", &format!("{API}/zones?per_page=50"), None)?;
    let zone_list = zones.as_array().cloned().unwrap_or_default();
    found.zones = zone_list
        .iter()
        .map(|z| Named { id: text(z, "id"), name: text(z, "name") })
        .filter(|z| !z.id.is_empty())
        .collect();
    if found.zones.is_empty() {
        return Err("That token cannot see any domain. It needs Zone → DNS → Edit.".into());
    }

    let from_zone = zone_list.iter().find_map(|z| {
        let a = z.get("account")?;
        let id = text(a, "id");
        (!id.is_empty()).then(|| Named { id, name: text(a, "name") })
    });

    // Only if a zone somehow did not name its account: ask the endpoint meant
    // for it after all. It is the fallback and not the first move because it is
    // the one that came back empty and started this.
    found.account = match from_zone {
        Some(a) => a,
        None => {
            let accounts = call(api_token, "GET", &format!("{API}/accounts?per_page=50"), None)?;
            let first = accounts.as_array().and_then(|a| a.first()).ok_or(
                "The domains this token can see do not name an account, and the account list \
                 came back empty. Check that the token covers Account → Cloudflare Tunnel → Edit.",
            )?;
            Named { id: text(first, "id"), name: text(first, "name") }
        }
    };

    let tunnels = call(
        api_token,
        "GET",
        &format!("{API}/accounts/{}/cfd_tunnel?is_deleted=false&per_page=50", found.account.id),
        None,
    )?;
    found.tunnels = tunnels
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|t| Named { id: text(t, "id"), name: text(t, "name") })
        .filter(|t| !t.id.is_empty())
        .collect();
    if found.tunnels.is_empty() {
        // Empty means one of two things and the answer cannot tell them apart:
        // the account really has no tunnel, or the token may not list them.
        // Say both rather than pick one.
        return Err(format!(
            "No tunnel found in {}. Either that account has none — sessionhub arranges \
             hostnames on a tunnel that already runs — or the token is missing \
             Account → Cloudflare Tunnel → Edit.",
            found.account.name
        ));
    }
    Ok(found)
}

/// Give one address a hostname: a DNS record pointing at the tunnel, and an
/// ingress rule sending that hostname to the listener standing in front of it.
pub fn expose(cf: &Cloudflare, f: &Forward) -> Result<String, String> {
    let host = cf.host_for(f);
    add_dns(cf, &host)?;

    let mut config = configuration(&cf.api_token, &cf.account_id, &cf.tunnel_id)?;
    let mut rules = ingress_of(&config);
    if rules.iter().any(|r| text(r, "hostname") == host) {
        info!(%host, "already in the tunnel's ingress");
        return Ok(host);
    }
    let at = insert_point(&rules)?;
    rules.insert(
        at,
        json!({ "hostname": host, "service": format!("http://localhost:{}", f.local) }),
    );
    put_ingress(cf, &mut config, rules)?;
    info!(%host, target = %f.target(), "an address was given a hostname");
    Ok(host)
}

/// Take the hostname away again: the rule first, then the record. In that order
/// — a record still pointing at a tunnel with no rule for it answers with
/// Cloudflare's own error page, which is a better half-way state than a rule
/// pointing at nothing.
pub fn withdraw(cf: &Cloudflare, f: &Forward) -> Result<(), String> {
    let host = cf.host_for(f);

    let mut config = configuration(&cf.api_token, &cf.account_id, &cf.tunnel_id)?;
    let rules = ingress_of(&config);
    let kept: Vec<Value> = rules.iter().filter(|r| text(r, "hostname") != host).cloned().collect();
    if kept.len() != rules.len() {
        // Checked while removing too: the guard is about what is left behind.
        insert_point(&kept)?;
        put_ingress(cf, &mut config, kept)?;
    }

    remove_dns(cf, &host)?;
    info!(%host, "an address gave its hostname back");
    Ok(())
}

// ------------------------------------------------------------------- ingress

fn configuration(api_token: &str, account: &str, tunnel: &str) -> Result<Value, String> {
    call(
        api_token,
        "GET",
        &format!("{API}/accounts/{account}/cfd_tunnel/{tunnel}/configurations"),
        None,
    )
    .map(|v| v.get("config").cloned().unwrap_or_else(|| json!({})))
}

fn ingress_of(config: &Value) -> Vec<Value> {
    config.get("ingress").and_then(|v| v.as_array()).cloned().unwrap_or_default()
}

/// Where a new rule goes: in front of the catch-all, which Cloudflare requires
/// to be last and which has no hostname of its own.
///
/// This is also where the whole feature is told to stop. Rewriting the ingress
/// of a live tunnel is the one thing here that can take a machine off the
/// internet, so an ingress that does not look the way it should is left alone
/// rather than repaired by guesswork.
fn insert_point(rules: &[Value]) -> Result<usize, String> {
    let Some(last) = rules.last() else {
        return Err(
            "That tunnel has no ingress rules at all — sessionhub will not write the first one."
                .into(),
        );
    };
    if !text(last, "hostname").is_empty() {
        return Err("That tunnel's ingress has no catch-all rule at the end. sessionhub will \
                    not rewrite an ingress it does not recognise."
            .into());
    }
    Ok(rules.len() - 1)
}

fn put_ingress(cf: &Cloudflare, config: &mut Value, rules: Vec<Value>) -> Result<(), String> {
    // Kept before every write, so a bad one can be put back by hand.
    let backup = crate::config::dir().join("cloudflare-ingress.json");
    if let Ok(text) = serde_json::to_string_pretty(config) {
        if let Err(e) = std::fs::write(&backup, text) {
            warn!(error = %e, "could not save the previous ingress");
        }
    }

    config["ingress"] = Value::Array(rules);
    call(
        &cf.api_token,
        "PUT",
        &format!("{API}/accounts/{}/cfd_tunnel/{}/configurations", cf.account_id, cf.tunnel_id),
        Some(&json!({ "config": config }).to_string()),
    )
    .map(|_| ())
}

// ----------------------------------------------------------------------- dns

fn add_dns(cf: &Cloudflare, host: &str) -> Result<(), String> {
    let body = json!({
        "type": "CNAME",
        "name": host,
        // Every tunnel answers on this name; the proxy in front is what makes a
        // CNAME to it resolve at all.
        "content": format!("{}.cfargotunnel.com", cf.tunnel_id),
        "proxied": true,
        "comment": "sessionhub",
    });
    match call(
        &cf.api_token,
        "POST",
        &format!("{API}/zones/{}/dns_records", cf.zone_id),
        Some(&body.to_string()),
    ) {
        Ok(_) => Ok(()),
        // Already there is the same as having made it.
        Err(e) if e.contains("81053") || e.contains("81057") || e.contains("already exists") => {
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn remove_dns(cf: &Cloudflare, host: &str) -> Result<(), String> {
    let found = call(
        &cf.api_token,
        "GET",
        &format!("{API}/zones/{}/dns_records?name={host}", cf.zone_id),
        None,
    )?;
    for rec in found.as_array().unwrap_or(&Vec::new()) {
        let id = text(rec, "id");
        if id.is_empty() {
            continue;
        }
        call(&cf.api_token, "DELETE", &format!("{API}/zones/{}/dns_records/{id}", cf.zone_id), None)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------- curl

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

/// One API call. Returns `result` on success, and on failure the message
/// Cloudflare gave rather than a status code.
fn call(api_token: &str, method: &str, url: &str, body: Option<&str>) -> Result<Value, String> {
    let scratch = Scratch::new(api_token, body)?;

    let mut args: Vec<String> = vec![
        "-sS".into(),
        "--max-time".into(),
        "30".into(),
        "--config".into(),
        scratch.auth.to_string_lossy().into_owned(),
        "-X".into(),
        method.to_string(),
        "-H".into(),
        "Content-Type: application/json".into(),
    ];
    if let Some(path) = &scratch.body {
        args.push("--data-binary".into());
        args.push(format!("@{}", path.to_string_lossy()));
    }
    args.push(url.to_string());

    let out = crate::pty::quiet_command(crate::pty::curl_path())
        .args(&args)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "could not reach Cloudflare: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let v: Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| "Cloudflare did not answer with JSON.".to_string())?;
    if v.get("success").and_then(|s| s.as_bool()) != Some(true) {
        let why = v
            .get("errors")
            .and_then(|e| e.as_array())
            .map(|list| {
                list.iter()
                    .map(|e| {
                        let code = e.get("code").and_then(|c| c.as_u64()).unwrap_or(0);
                        format!("{} ({code})", text(e, "message"))
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_default();
        return Err(if why.is_empty() { "Cloudflare refused that.".into() } else { why });
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

/// The two files a call may need, removed when it ends however it ends.
struct Scratch {
    auth: PathBuf,
    body: Option<PathBuf>,
}

impl Scratch {
    fn new(api_token: &str, body: Option<&str>) -> Result<Scratch, String> {
        let dir = crate::config::dir();
        let _ = std::fs::create_dir_all(&dir);
        let stamp = format!("{}-{:?}", std::process::id(), std::thread::current().id());

        let auth = dir.join(format!(".cf-auth-{stamp}"));
        write_private(&auth, &format!("header = \"Authorization: Bearer {api_token}\"\n"))?;

        let body = match body {
            Some(text) => {
                let path = dir.join(format!(".cf-body-{stamp}.json"));
                write_private(&path, text)?;
                Some(path)
            }
            None => None,
        };
        Ok(Scratch { auth, body })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.auth);
        if let Some(b) = &self.body {
            let _ = std::fs::remove_file(b);
        }
    }
}

fn write_private(path: &PathBuf, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(hosts: &[&str], catch_all: bool) -> Vec<Value> {
        let mut out: Vec<Value> = hosts
            .iter()
            .map(|h| json!({ "hostname": h, "service": "http://localhost:7717" }))
            .collect();
        if catch_all {
            out.push(json!({ "service": "http_status:404" }));
        }
        out
    }

    #[test]
    fn a_new_rule_goes_in_front_of_the_catch_all() {
        let r = rules(&["sbox.example.com", "other.example.com"], true);
        assert_eq!(insert_point(&r).unwrap(), 2);
    }

    #[test]
    fn an_ingress_that_looks_wrong_is_left_alone() {
        // Cloudflare requires a catch-all last, so an ingress without one is not
        // an ingress this understands.
        assert!(insert_point(&rules(&["sbox.example.com"], false)).is_err());
        assert!(insert_point(&[]).is_err());
    }
}
