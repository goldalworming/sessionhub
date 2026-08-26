//! Arranging a hostname for a local port, through the Cloudflare API.
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

use std::path::PathBuf;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::config::Cloudflare;

const API: &str = "https://api.cloudflare.com/client/v4";

/// What a token turned out to be able to reach. Named rather than assumed, so
/// the panel can show it and let a wrong guess be refused.
#[derive(Debug, Clone, Default)]
pub struct Found {
    pub account_id: String,
    pub account_name: String,
    pub zone_id: String,
    pub zone_name: String,
    pub tunnel_id: String,
    pub tunnel_name: String,
}

/// The hostname sessionhub itself is reached at, read out of the pattern: the
/// place for the number, and the separator in front of it, removed.
pub fn base_host(pattern: &str) -> String {
    let (_, after) = pattern.split_once("{port}").unwrap_or(("", pattern));
    after.trim_start_matches(['-', '.', '_']).to_string()
}

/// Follow a token to the account, the zone and the tunnel already carrying
/// sessionhub. Nothing is written here; this only looks.
pub fn discover(api_token: &str, pattern: &str) -> Result<Found, String> {
    let host = base_host(pattern);
    if host.is_empty() {
        return Err("The hostname pattern needs a `{port}` and a domain after it.".into());
    }

    let mut found = Found::default();

    let accounts = call(api_token, "GET", &format!("{API}/accounts?per_page=50"), None)?;
    let first = accounts.as_array().and_then(|a| a.first()).ok_or(
        "That token cannot see any account. It needs Account → Cloudflare Tunnel → Edit.",
    )?;
    found.account_id = text(first, "id");
    found.account_name = text(first, "name");

    // The zone whose name is the longest suffix of the hostname. Matching by
    // suffix rather than by cutting at the second dot keeps `example.co.uk`
    // working without carrying a list of public suffixes around.
    let zones = call(api_token, "GET", &format!("{API}/zones?per_page=50"), None)?;
    let mut best = String::new();
    for z in zones.as_array().unwrap_or(&Vec::new()) {
        let name = text(z, "name");
        let matches = host == name || host.ends_with(&format!(".{name}"));
        if matches && name.len() > best.len() {
            best = name.clone();
            found.zone_id = text(z, "id");
            found.zone_name = name;
        }
    }
    if found.zone_id.is_empty() {
        return Err(format!(
            "No zone in that account covers {host}. Check the hostname, and that the token \
             carries Zone → DNS → Edit for it."
        ));
    }

    // The tunnel already serving that hostname — the one this browser is
    // talking through right now. Found rather than asked for, because a UUID is
    // a poor thing to make someone go and look up.
    let tunnels = call(
        api_token,
        "GET",
        &format!("{API}/accounts/{}/cfd_tunnel?is_deleted=false&per_page=50", found.account_id),
        None,
    )?;
    for t in tunnels.as_array().unwrap_or(&Vec::new()) {
        let id = text(t, "id");
        if id.is_empty() {
            continue;
        }
        let Ok(cfg) = configuration(api_token, &found.account_id, &id) else { continue };
        if ingress_of(&cfg).iter().any(|r| text(r, "hostname") == host) {
            found.tunnel_id = id;
            found.tunnel_name = text(t, "name");
            break;
        }
    }
    if found.tunnel_id.is_empty() {
        return Err(format!(
            "No tunnel in that account serves {host}. sessionhub arranges hostnames on the \
             tunnel it is already reached through, so that one has to exist first."
        ));
    }
    Ok(found)
}

/// Give one port a hostname: a DNS record pointing at the tunnel, and an ingress
/// rule sending that hostname to the forwarder.
pub fn expose(cf: &Cloudflare, port: u16) -> Result<String, String> {
    let host = cf.host_for(port);
    add_dns(cf, &host)?;

    let mut config = configuration(&cf.api_token, &cf.account_id, &cf.tunnel_id)?;
    let mut rules = ingress_of(&config);
    if rules.iter().any(|r| text(r, "hostname") == host) {
        info!(%host, "already in the tunnel's ingress");
        return Ok(host);
    }
    let at = insert_point(&rules, &base_host(&cf.hostname))?;
    rules.insert(
        at,
        json!({ "hostname": host, "service": format!("http://localhost:{}", cf.forward_port) }),
    );
    put_ingress(cf, &mut config, rules)?;
    info!(%host, port, "a port was given a hostname");
    Ok(host)
}

/// Take the hostname away again: the rule first, then the record. In that order
/// — a record still pointing at a tunnel with no rule for it answers with
/// Cloudflare's own error page, which is a better half-way state than a rule
/// pointing at nothing.
pub fn withdraw(cf: &Cloudflare, port: u16) -> Result<(), String> {
    let host = cf.host_for(port);

    let mut config = configuration(&cf.api_token, &cf.account_id, &cf.tunnel_id)?;
    let rules = ingress_of(&config);
    let kept: Vec<Value> = rules.iter().filter(|r| text(r, "hostname") != host).cloned().collect();
    if kept.len() != rules.len() {
        // Still checked, even while removing: the guard is about what is left
        // behind, not about what is going.
        insert_point(&kept, &base_host(&cf.hostname))?;
        put_ingress(cf, &mut config, kept)?;
    }

    remove_dns(cf, &host)?;
    info!(%host, port, "a port gave its hostname back");
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
/// of a live tunnel is the one thing here that can take sessionhub itself off
/// the internet, so a config that does not look the way it should is left alone
/// rather than repaired by guesswork.
fn insert_point(rules: &[Value], base: &str) -> Result<usize, String> {
    let Some(last) = rules.last() else {
        return Err("That tunnel has no ingress rules at all — sessionhub will not write the \
                    first one."
            .into());
    };
    if !text(last, "hostname").is_empty() {
        return Err("That tunnel's ingress has no catch-all rule at the end. sessionhub will \
                    not rewrite an ingress it does not recognise."
            .into());
    }
    if !rules.iter().any(|r| text(r, "hostname") == base) {
        return Err(format!(
            "That tunnel no longer has a rule for {base}, which is how sessionhub itself is \
             reached. Nothing was changed."
        ));
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
        &format!(
            "{API}/accounts/{}/cfd_tunnel/{}/configurations",
            cf.account_id, cf.tunnel_id
        ),
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
        call(
            &cf.api_token,
            "DELETE",
            &format!("{API}/zones/{}/dns_records/{id}", cf.zone_id),
            None,
        )?;
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

    let out = crate::pty::quiet_command(curl_path())
        .args(&args)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        return Err(format!("could not reach Cloudflare: {}", String::from_utf8_lossy(&out.stderr).trim()));
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

/// The system's own curl, by absolute path on Windows — `curl` on PATH there is
/// often an alias for PowerShell's `Invoke-WebRequest`, which takes different
/// arguments entirely. The same reasoning as `update.rs`.
fn curl_path() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Windows\System32\curl.exe")
    } else {
        PathBuf::from("curl")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_base_hostname_is_read_out_of_the_pattern() {
        assert_eq!(base_host("{port}-sbox.example.com"), "sbox.example.com");
        assert_eq!(base_host("{port}.sbox.example.com"), "sbox.example.com");
        assert_eq!(base_host("{port}_box.example.com"), "box.example.com");
    }

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
        assert_eq!(insert_point(&r, "sbox.example.com").unwrap(), 2);
    }

    #[test]
    fn an_ingress_that_looks_wrong_is_left_alone() {
        // No catch-all: Cloudflare requires one last, so this is not an ingress
        // we understand.
        let r = rules(&["sbox.example.com"], false);
        assert!(insert_point(&r, "sbox.example.com").is_err());

        // Nothing at all.
        assert!(insert_point(&[], "sbox.example.com").is_err());

        // sessionhub's own rule has gone: writing here could take it off the
        // internet, so it does not write.
        let r = rules(&["other.example.com"], true);
        let why = insert_point(&r, "sbox.example.com").unwrap_err();
        assert!(why.contains("sbox.example.com"), "{why}");
    }
}
