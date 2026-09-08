# Microsoft 365

An installable Bedrock Panel drop-in for Microsoft 365 calendar, presence, app launching, Teams
meeting links, and configurable desktop shortcuts.

Install it from **Settings → Drop-In Apps → Browse**, then add or select a Microsoft 365 app page.
Use that page's **Microsoft 365 account** section in the desktop editor to Connect or Disconnect;
the panel also offers **Connect** when the account is not linked. The OAuth provider and encrypted
token are scoped to this app as `app:office`; no global Microsoft connection is required.

The server module runs with host privileges so it can focus or launch desktop Office apps and send
configured key combinations. Only install the package from a source you trust.
