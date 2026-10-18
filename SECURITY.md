# Security policy

## Supported versions

Only the latest release (0.1.x) receives fixes.

## Threat model

Agent Hospital is a **single-user, localhost viewer**:

- **No authentication.** Anyone who can reach the HTTP port can read the agent state, the case files and the
  transcripts shown in live mode.
- **Loopback only by default.** `docker compose` publishes the port as `127.0.0.1:8700` only. Do not publish it on
  other interfaces or a LAN without a deliberate decision and a review of `HOSPITAL_ALLOWED_HOSTS`.
- **`docker run -p 8700:8700` binds all interfaces** on the host. Do not use it for this app.
- **Read-only inputs.** Live mode mounts transcripts and case files with `:ro`. The app does not write to them.
- **Redaction is best effort.** Common secret formats are masked before display. Other secrets, and anything inside
  screenshots, can be shown as they are. Do not rely on it to keep secrets out of view.

Guards that exist: a `Host` allow-list (other hosts get `421`), an `Origin` check on `/api/*` (cross-site requests get
`403`), and a path confinement for transcripts and case files (symlinks that leave the mounted roots are rejected).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**. Include the version, the steps to reproduce and the
expected impact.
