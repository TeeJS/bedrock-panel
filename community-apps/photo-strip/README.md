# Photo Strip

Photo Strip is an ambient local-photo slideshow designed specifically for the Bedrock Panel
1920×480 panel. Add it as a drop-in app page, then choose one or more folders in that page's
App settings.

The renderer never receives folder paths and has no filesystem access. The app-local
`server.js` scans only the configured folders, returns opaque image IDs, and validates each
requested image against the cached scan and its selected root before reading it. Scans are
asynchronous, cached for five minutes, manually refreshable, and bounded to 2,000 directories.
**Maximum library size** defaults to 500 photos and can be changed in App settings from 100 up to
the hard ceiling of 10,000. The renderer itself keeps only the current photo neighbourhood loaded.

JPEG, PNG, WebP, and GIF files are supported. GIFs use Chromium's normal image rendering, so an
animated GIF plays while it is the current slide and restarts if it is evicted and loaded again;
Photo Strip does not attempt frame-level timing or animation control.

The panel knob rotates through photos. A single press pauses or resumes, and a double press opens
the settings summary. Touch or click the photograph to reveal the temporary control overlay.

Photo deletion is off by default. Enable **Allow deleting photos** in the page's App settings to
show a Delete control. The panel asks for confirmation each time, then requests that the host move
the original file to the operating system Recycle Bin or Trash.

Windows may not provide Recycle Bin support for mapped drives or UNC network shares. For a NAS such
as QNAP, also enable **Allow direct delete fallback**. Photo Strip still tries the operating-system
Recycle Bin first, but if that fails it deletes directly from the share. Recovery in that case
depends entirely on the NAS Network Recycle Bin being enabled for the share; otherwise the deletion
may be permanent.
