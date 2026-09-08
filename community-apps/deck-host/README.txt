Stream Deck Host
================

Run Elgato Stream Deck plugins AND profiles on the Bedrock Panel panel. The app
implements Elgato's documented plugin protocol (the same approach as
OpenDeck), so unmodified *.sdPlugin packages work: the host launches each
plugin, and the on-screen key grid shows the images and titles the plugin
draws. Tap a key to press it. Shared *.streamDeckProfile files import as
ready-made key layouts, including the built-in Elgato actions most profiles
are made of -- Hotkey, Text, Open, and folder keys -- which this host
implements itself (keystrokes are sent as real keyboard input).

SECURITY: Stream Deck plugins are real programs that run on your PC with
your user rights. Only add plugins you trust, exactly as you would any
downloaded software. (Bedrock Panel also warns once when importing this app,
because it contains a host-side server module.)

Setup
-----
1. Install the app (Settings -> Drop-In Apps -> Browse... or import the zip)
   and add a page for it.
2. Make a folder anywhere on your PC and put your *.sdPlugin folders in it
   (each looks like com.example.something.sdPlugin and contains a
   manifest.json). Get plugins from their developers' releases.
3. Set that folder as the page's "Plugins folder" option. The header shows
   how many plugins are running; the Plugins button shows status and offers
   a restart.

Using the deck
--------------
- Tapping a key presses it (finger down = key down, lift = key up, just
  like the hardware). Tap "Edit", then tap ANY key -- assigned or empty --
  to assign, move, clear, or configure it (settings are raw JSON;
  property-inspector UIs aren't rendered yet). Tap "Done" when finished.
- Profiles (left rail): separate key layouts. "+ Profile" adds one (tap
  twice -- stray-tap protection); in Edit mode a profile's X removes it.
  Rename/add/remove is also in the PC editor on this page's options.
  Turning the knob cycles profiles.
- Key size is a page option: 3 keys high (more keys) or 2 keys high
  (jumbo). Keys are square, like the hardware; how many columns fit is
  worked out from the screen automatically, and that computed size is the
  device size reported to plugins.
- Half quake / half deck: enable the page's "Buttons" strip in the editor
  to put Bedrock Panel launcher tiles beside the deck -- the deck sits on its
  own black bezel plate, so the two are impossible to confuse.
- Importing profiles: drop *.streamDeckProfile files (or zips containing
  them) anywhere in your plugins folder; they're listed BOTH in the Plugins
  pane ("Profiles in this folder") and under the Profile button -- tap
  Import on one. Importing creates one deck profile per page (folder keys
  navigate between them; Back returns), keeps the original key faces, and
  reflows keys from taller devices (e.g. an 8x4 XL) into extra columns.
  Importing the same file again replaces its earlier import. On Windows
  pick the Windows variant of a profile when both are offered -- Mac
  hotkeys use Mac keys. Keys that need a plugin you don't have say so on
  their face and start working once it's installed.
- Mix and match: imported keys are ordinary keys. In Edit mode, tap a key
  for Copy to... (duplicate it onto any other profile), Move..., or Clear.
  The assign list also offers BUILT-IN keys you can create from scratch --
  Hotkey, Text, Open, Website -- configured via their settings JSON
  ("key" takes names like C, F5, ENTER, VOLUMEUP; "title" labels the key).
- Assignments and settings persist in deck-host.json next to your plugins
  folder, so they survive app updates.

What works / what doesn't (yet)
-------------------------------
Works: Keypad actions from native (.exe) and Node.js plugins -- key images
(setImage), titles, states, alerts/OK ticks, per-key and global settings,
crash auto-restart. Profile import with built-in Hotkey (real keystrokes,
incl. Win-key combos), Text (paste or type, optional Enter), Open
(apps/files/URLs), Website, and folder navigation keys.
Not yet: property-inspector configuration pages, plugins whose CodePath is
an HTML file (they need Elgato's embedded browser runtime), dial/Encoder
actions, multi-actions, setFeedback layouts, Elgato Marketplace downloads
(their packages are encrypted -- both plugins and profiles must come from
developers' own releases).
