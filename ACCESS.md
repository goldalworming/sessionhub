# Reaching it from a phone

How a phone on mobile data gets to a terminal on a machine at home, and to the
dev servers running beside it — including one on a second machine that cannot
run a tunnel of its own.

Hostnames below are placeholders. The real ones live in `~/.sessionhub/config.toml`
and are salted hashes of what they point at, so they cannot be guessed from the
port they lead to.

## The shape of it

```plantuml
@startuml
skinparam componentStyle rectangle
skinparam shadowing false

actor "phone" as phone

cloud "Cloudflare" as cf {
  component "edge\nTLS ends here" as edge
}

node "main machine (Windows)" as main {
  component "cloudflared\ntunnel run --token" as cfd
  component "sessionhubd :7717" as daemon
  component "forwarder :7801" as f1
  component "forwarder :7802" as f2
  component "Vite :5173" as vite
  component "backend :8001" as api
}

node "second machine (Mac)\nVPN blocks cloudflared" as mac {
  component "sessionhubd :7717" as macd
  component "service :3100" as svc
}

phone --> edge : https
edge --> cfd : one outbound tunnel\nnothing is listening inbound
cfd --> daemon : sbox.example.com
cfd --> f1 : a1b2c3.example.com
cfd --> f2 : d4e5f6.example.com

daemon --> vite : (never - see note)
f1 --> vite : 127.0.0.1:5173
f2 --> svc : 192.168.0.104:3100\nthe only hop across the LAN
daemon --> macd : via=mac, over the LAN

note bottom of main
  Every port here is bound to loopback.
  The tunnel dials out; the router has
  no port forwarded to this machine.
end note
@enduml
```

The daemon never talks to Vite — that arrow is only there to be denied. A
forwarded address gets its own listener, and that listener is the only thing
that ever dials the target.

## Opening sessionhub itself

The token rides in the address once, then lives in a cookie for that hostname.

```plantuml
@startuml
skinparam shadowing false
actor phone
participant "Cloudflare" as cf
participant "cloudflared" as cfd
participant "sessionhubd :7717" as d

phone -> cf : GET sbox.example.com/?token=...
cf -> cfd : over the tunnel
cfd -> d : GET /?token=...
d --> phone : 200 + Set-Cookie: sh_token
note right of phone
  From here the cookie carries it.
  The token never appears again.
end note

phone -> d : GET /app.js  (cookie)
d --> phone : the interface

phone -> d : WebSocket /ws  (cookie)
d --> phone : terminals, sessions, files
@enduml
```

## A terminal on the second machine

The phone never reaches the Mac directly. It asks the main daemon, which relays
the whole WebSocket byte for byte using the token it was paired with.

```plantuml
@startuml
skinparam shadowing false
actor phone
participant "sessionhubd\nmain" as d
participant "sessionhubd\nMac" as m

phone -> d : WebSocket /ws?via=mac
activate d
d -> d : look up "mac" in config\n(address + its own token)
d -> m : WebSocket /ws?token=<mac's token>
activate m
m --> d : session list, PTY output
d --> phone : the same bytes, unread
deactivate m
deactivate d

note over d
  Only names already paired are relayed.
  A free address would make this an
  open proxy for whoever holds the token.
end note
@enduml
```

## A dev server, on this machine

```plantuml
@startuml
skinparam shadowing false
actor phone
participant "Cloudflare" as cf
participant "cloudflared" as cfd
participant "forwarder :7801" as f
participant "Vite :5173" as vite

phone -> cf : GET a1b2c3.example.com/?token=...
cf -> cfd : over the tunnel
cfd -> f : GET /?token=...
f -> f : token ok
f --> phone : 302 to /  + Set-Cookie
note right of phone
  Its own hostname, so its own cookie.
  Opening sessionhub earlier does not
  count for this one.
end note

phone -> f : GET /  (cookie)
f -> vite : the same request, untouched
vite --> f : index.html
f --> phone : passed through

phone -> f : GET /@vite/client, /src/main.ts ...
f -> vite : untouched
note over f, vite
  Vite believes it is at the root of its
  own host, so nothing has to be rewritten.
  A path prefix would have broken every
  one of these.
end note

phone -> f : WebSocket (hot reload)
f -> vite : upgraded and pumped raw
@enduml
```

Two loopbacks are tried, not just the one written down: a dev server told to
listen on `localhost` may bind `::1` alone, which a browser reaches and a
literal `127.0.0.1` does not.

## A service on the second machine

Same path until the last hop. cloudflared runs on the main machine because the
Mac's VPN will not let it; only the final dial crosses the LAN.

```plantuml
@startuml
skinparam shadowing false
actor phone
participant "Cloudflare" as cf
participant "cloudflared\n(main machine)" as cfd
participant "forwarder :7802\n(main machine)" as f
participant "service :3100\n(Mac)" as svc

phone -> cf : GET d4e5f6.example.com/  (cookie)
cf -> cfd : over the tunnel
cfd -> f : GET /
f -> f : is 192.168.0.104 allowed?\nprivate address, on the list
f -> svc : 192.168.0.104:3100
svc --> f : the page
f --> phone : passed through

note over f
  This machine, or a private address.
  Never a public one, and never a name
  that could resolve anywhere.
end note
@enduml
```

## Where a hostname comes from

Two ways, and the difference is whether the name stays put.

```plantuml
@startuml
skinparam shadowing false
actor you
participant "sessionhubd" as d
participant "Cloudflare API" as api
participant "cloudflared" as cfd

group With an API token
  you -> d : add 127.0.0.1:5173
  d -> d : name = hash(salt + target)
  d -> api : create CNAME -> <tunnel>.cfargotunnel.com
  d -> api : read the tunnel's ingress
  d -> api : write it back, one rule added\nbefore the catch-all
  note right of d
    The previous ingress is saved first.
    Rewriting a live one is the only step
    here that could take the machine off
    the internet.
  end note
  d --> you : https://a1b2c3.example.com
end

group Without one
  you -> d : add 127.0.0.1:5173
  d -> cfd : cloudflared tunnel --url http://127.0.0.1:7801
  cfd --> d : https://<random>.trycloudflare.com
  d --> you : that address, new every start
end
@enduml
```

## What holds it shut

- Nothing listens for inbound connections at home. cloudflared dials out.
- Every sessionhub port is bound to loopback; the forwarders too.
- Only addresses added by hand are reachable, and only loopback or a private
  address — a leaked token cannot become a way into the whole network.
- Each hostname is its own origin with its own cookie, so reaching one says
  nothing about reaching the next.
- The names are salted, so knowing one tells you nothing about the others.
- What sits behind them is still a dev server. Vite will serve files from
  outside the project through `/@fs/`; the token in front is what makes that
  survivable.
