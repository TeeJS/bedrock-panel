# Bedrock Panel — installer return codes

`bedrock-panel-setup.exe` is an NSIS installer (produced by electron-builder). It reports
the outcome of an install or uninstall through its **process exit code**:

| Return code | Meaning |
|---|---|
| `0` | **Success** — the installation (or uninstall) completed. |
| `1` | **Cancelled** — the user cancelled the installer, or it exited before completing. |
| `2` | **Aborted** — the installer stopped because of a fatal error in the install script. |

`0` is the only success code; **any non-zero exit code means the installation did not complete
successfully.**

## Silent install

The installer supports unattended/silent installation with the standard NSIS `/S` flag:

```
bedrock-panel-setup.exe /S
```

It installs per-user (no elevation required) and returns `0` on success.
