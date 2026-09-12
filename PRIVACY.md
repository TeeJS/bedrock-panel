# Privacy Policy — Bedrock Panel

_Last updated: 2026-09-07_

Bedrock Panel (formerly open-quake) is a free, open-source launcher and control platform for
Windows, macOS, and Linux — on a compatible computer, a touchscreen, or with optional controllers.
This policy explains what data the app does and does not handle.

## The short version

**Bedrock Panel does not collect, transmit, sell, or share any personal data.** It has no
analytics, no telemetry, no advertising, no user accounts, and makes no network
connections to the developer. Everything it stores stays on your own PC.

## What is stored, and where

Bedrock Panel saves its configuration locally on your computer under
`%APPDATA%\bedrock-panel` (for example `C:\Users\<you>\AppData\Roaming\bedrock-panel`). This
includes your page layouts, tiles, app settings, and any URLs or credentials you choose
to enter for your own web-dashboard pages. **This data never leaves your device** through
any action of Bedrock Panel, and the developer never receives it.

## Web dashboard pages

Bedrock Panel can display web pages that you configure (for example Home Assistant,
Grafana, or a weather map) inside an embedded browser view. When you do this, you are
connecting to those third-party websites directly, and your use of them is governed by
**their** privacy policies, not this one. Any access tokens, passwords, or headers you
enter for a dashboard are stored locally and are sent only to the website you configured
them for.

## The device (USB and microphone)

When a supported controller is connected (such as the DK-QUAKE / ARIS-68 panel), Bedrock Panel
communicates with it over USB (HID) to handle touch input, the knob, the ring lighting, and to
switch the device's microphone on or off. **Bedrock Panel
does not record, capture, or transmit audio.** The device's microphone is a standard USB
audio input that any application can use; Bedrock Panel itself does not read from it.

## Children

Bedrock Panel is a general-purpose utility and is not directed at children.

## Changes to this policy

If this policy changes, the updated version will be posted at this URL with a new
"last updated" date.

## Contact

Questions about this policy? Open an issue at
<https://github.com/TeeJS/bedrock-panel/issues> or email **teejschmitz@gmail.com**.
