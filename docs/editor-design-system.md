# Editor UI Design System

## Purpose

This document defines how the PC-side Bedrock Panel Editor should look and behave.
It applies to the editor shell, page editors, grid editor, Settings, dialogs, and
integration-management interfaces.

The panel has different constraints and follows
[`design-system.md`](design-system.md). The panel is a 1920×480 touch appliance;
the Editor is a desktop configuration tool. They share a visual identity, but
they do not share the same density, navigation, or control sizes.

## Philosophy

The Editor should feel like a **focused control panel**, not a raw configuration
file rendered as a form.

### Design priorities

1. Make the current context obvious.
2. Keep common tasks direct.
3. Preserve working functionality and predictable behavior.
4. Explain unfamiliar concepts without filling the screen with instructions.
5. Use the same interaction pattern for the same job everywhere.
6. Keep advanced capability available without making the basic workflow feel
   advanced.

Every screen should answer four questions quickly:

- Where am I?
- What am I editing?
- What will this change affect?
- Is the current state saved and usable?

## Complexity rule

Every additional state, condition, control, and explanation has a cost. Add one
only when it improves the specific workflow being designed. Do not apply a
pattern mechanically when the feature's behavior calls for a different result.

Use context-specific judgment for dependent controls:

- Keep a control available when configuring it in advance is useful.
- Disable a control when the action genuinely cannot succeed in the current
  state, and state why.
- Hide a dependent field when it has no meaning until its parent feature is on
  and hiding it materially improves the page.
- Preserve the user's configured value when a parent feature is turned off.

## Application shell

The Editor uses four stable regions:

```text
Header
Sidebar | Editor content
Footer
```

### Header

The header contains:

- Product name and version
- One short usage or device-status message
- Settings or the equivalent return action

Do not place page-specific controls in the header. Keep the center message short
and stable so it does not compete with the current editor.

When Settings is open, the Settings action must visibly reflect that state. Use
a return or close label rather than presenting Settings as unopened.

### Sidebar

The sidebar provides Pages, Groups, and Panes navigation.

- Keep the active mode and selected item unmistakable.
- Keep filtering at the top and creation at the bottom.
- Scroll the item list, not the entire sidebar.
- Truncate long names with an ellipsis and expose the full name in a tooltip.
- Show secondary metadata, such as shortcuts and Hidden status, below or beside
  the name without competing with it.
- Use one icon style for page types.
- Make drag handles visible on hover and keyboard reordering available.

Settings has its own grouped navigation. Do not allow multiple navigation
systems to compete for attention. At widths where the page sidebar makes
Settings cramped, collapse the page sidebar while Settings is open.

### Content area

The content area contains one selected page, grid, pane, group, or Settings
category.

- Start a newly selected editor at the top.
- Use a readable content width for text-heavy forms.
- Allow grids, tables, and master-detail editors to use the available width.
- Keep the primary editing surface visible while related details are edited.
- Do not stretch naturally short controls to fill the window.

### Footer

The footer contains persistence state and the global save action.

Use these states consistently:

- All changes saved
- Unsaved changes
- Saving…
- Changes applied to panel
- Unable to save
- Panel unavailable, when relevant

The primary action is **Save & apply**. A disabled Save & apply button means
there are no pending changes, not that saving is unavailable.

## Navigation

Navigation must preserve location and avoid surprise.

- Selecting a page shows that page's editor.
- Selecting a Settings category shows that category at its top.
- Returning from Settings restores the previously selected page.
- Page filtering must not change page order or delete selection.
- Buttons that navigate must use destination language: **Back to pages**,
  **Settings**, and **Show on device**.
- Do not use an unlabeled icon when a short text label is clearer.

## Page editor anatomy

App and dashboard page editors follow this order:

1. **Identity** — page name and page/app type
2. **App-specific configuration** — only settings belonging to that app
3. **Page behavior** — side button strip, rotation, shortcut, and advanced page
   behavior
4. **Device action** — Show on device
5. **Danger zone** — Delete page

Keep this order consistent so users know where shared controls live.

### Page behavior

Use the following names everywhere:

- **Side button strip**
- **Include in rotation**
- **Jump-to-page shortcut**
- **Pause rotation when this shortcut is used**
- **Advanced settings**
- **Show on device**

Do not rename these controls per app. Do not duplicate them inside app-specific
configuration.

The pause-rotation checkbox is independent working functionality. Keep it
available and preserve its value whether or not the shortcut field is currently
filled.

Place configuration for the side button strip immediately after its control or
on the Buttons view that appears when enabled. The text must tell the user where
the configuration appears.

### Grid editor

The grid is the primary surface on a grid page.

- Keep the grid visible while a tile is edited.
- Make the selected tile unmistakable.
- Use a purposeful empty state when no tile is selected.
- Warn before a size change removes configured tiles.
- Put layout controls together.
- Put Delete grid in the Danger zone after the editor, not before the grid.
- Make block selection and merging discoverable after the first tile is
  selected; do not rely on instructions alone.

## Settings anatomy

Settings uses grouped vertical navigation and one content column.

Use stable categories:

- General
- Device
- Apps
- Integrations
- Automation

Each Settings page contains:

1. A page title
2. One short description when the purpose is not self-evident
3. Clearly titled sections
4. Related controls
5. Contextual status and help

Do not add content merely to fill empty space. A short settings page is a good
settings page when the feature is simple.

Use cards for independent integrations, connection accounts, or strongly
bounded control groups. Do not put every section in a card.

Use master-detail layouts for collections whose items contain several fields,
including AI Profiles and Routines. Use simple lists for one-value collections.

## Forms

### Labels

- Use persistent visible labels; placeholders do not replace labels.
- Use sentence case.
- Keep terminology user-facing and put protocol or implementation terms in
  supporting help.
- Use the same label for the same concept everywhere.
- Place labels above controls when horizontal space is tight or labels vary
  greatly in length.

### Inputs

- Use text inputs for free text, number inputs for bounded numeric values,
  selects for small known sets, and searchable pickers for long known sets.
- Keep short values, such as ports, intervals, and row counts, in short fields.
- Place units directly beside numeric values.
- Apply the same visual treatment to inputs, selects, and text areas.
- Show validation next to the affected field.
- Preserve valid user input when a neighboring option changes.

### Checkboxes

Use checkboxes for independent Boolean settings. The label must describe the
enabled state positively.

Good:

```text
☑ Include in rotation
```

Bad:

```text
☑ Don't disable rotation
```

Keep the checkbox and its label together. Do not position a checkbox at one end
of a row and its label at the other.

### Selectors

Select labels must describe the setting, while options describe values.

Good:

```text
Default platform  [Teams ▾]
```

Avoid placing explanatory paragraphs inside option labels. Put the explanation
below the selector and update it when the value changes.

### Sliders

Use sliders only when relative adjustment is more important than an exact
value. Show a readable value beside the slider. Use percentages for user-facing
brightness and speed unless the hardware value itself is meaningful.

### Shortcuts

- Capture key combinations in a dedicated shortcut input.
- Display shortcuts in normalized form.
- Provide an inline clear action.
- Detect conflicts and identify the conflicting action.
- Distinguish app-action shortcuts from the Jump-to-page shortcut.
- State when a shortcut applies only after Save & apply.

## Actions

Every button must have one clear result.

### Primary actions

Use the accent treatment for the principal action in the current context:

- Save & apply
- Add page
- Check for updates
- Connect

Do not place multiple competing primary buttons in one region.

### Secondary actions

Use the neutral treatment for:

- Browse…
- Test connection
- Show on device
- Reload app list
- Refresh data
- Edit instructions

Use a specific verb and object. **Refresh** alone is insufficient when several
different things can be refreshed.

### Immediate actions

When a setting applies immediately, say so beside the control. When a device
setting also has a separate persistence operation, name that operation
specifically, such as **Store ring settings on device**. Do not make it look like
a second global save button.

### Destructive actions

- Put destructive actions in a labeled **Danger zone** at the bottom.
- Use red only for destructive or critical-error actions.
- Include the target name in confirmation text.
- Explain material consequences before confirmation.
- Do not place Delete beside ordinary navigation, preview, or connection
  actions.

## Help and instructions

The interface teaches at the point of use without becoming a manual.

### Persistent help

Keep persistent help to one short sentence. Use it for information needed to
operate the control correctly.

### Expandable help

Use **More…** for:

- Setup steps
- Technical details
- Security and storage explanations
- Edge cases
- Examples

The collapsed summary must still be useful. Do not make **More…** the only clue
to what a control does.

### Warnings

Show warnings only when the relevant state exists. Use plain language, describe
the consequence, and state the corrective action.

### Terminology

Use one term for each concept:

- Page, grid, dashboard, app, group, and pane retain their specific meanings.
- **Press** describes the physical knob action.
- **Click** describes mouse interaction.
- **Tap** describes touchscreen interaction.
- **Save & apply** persists editor changes and sends them to the panel.
- **Show on device** navigates the device to the saved page.

## Integrations and connections

Each external service uses the same pattern:

```text
Service name                         Status
Connection fields
Test connection   Connect/Disconnect
Result or error
```

Use these statuses:

- Connected
- Not configured
- Disabled
- Connecting…
- Error

Place status beside the service name. Place test results beside the action that
produced them.

Only show **Disconnect** for a connected account. Use **Connect** for an
unconfigured account and **Change account** when replacing an existing account.

### Secrets

- Mask secrets and provide an accessible reveal control when editing requires
  it.
- Do not put secrets in URLs, logs, help, examples, screenshots, or status
  messages.
- When practical, display **API key saved** or **Token saved** with Replace and
  Remove actions instead of presenting a stored secret as an ordinary filled
  text field.
- State that secrets are encrypted at rest once per relevant integration, not
  beneath every field.

### Connection testing

- Test the values currently entered, even before Save & apply.
- Report success, failure, and useful next action.
- Do not report a generic failure when the app can identify authentication,
  network, or version errors.
- Keep test actions secondary to Save & apply.

## Collections and tables

Use tables for repeated data with stable columns. Use master-detail editors when
each item has several editable fields.

- Keep search and creation controls visible.
- Show item counts.
- Provide clear empty states.
- Use sortable columns when sorting helps users locate or compare items.
- Give icon-only row menus an accessible name and tooltip.
- Show selection only when selecting a row has a result.
- Confirm deletion when another page, tile, or routine references the item.

## Visual hierarchy

Every editor has one primary surface or task.

Examples:

- Grid page → tile grid
- App page → app-specific settings
- Drop-in apps → installed-app table
- AI Profiles → selected profile editor
- Theme → theme controls and preview

Shared metadata and help must not compete with the primary surface.

## Cards and dividers

Cards organize independent bounded objects:

- Connected accounts
- External services
- Selected-item editors
- Control groups with their own status or actions

Dividers separate sequential sections within one form.

Do not wrap every field in a card. Excessive surfaces make the interface look
heavier without improving comprehension.

## Color

Reserve color for meaning.

| Meaning | Color |
| --- | --- |
| Primary action and selection | Accent blue |
| Success and saved state | Green |
| Warning and unsaved state | Amber |
| Error and destructive action | Red |
| Disabled or unavailable | Gray |
| Background and surfaces | Dark neutrals |

Do not use success green for ordinary metadata. Do not use red merely to attract
attention.

## Typography

Use Segoe UI or the system sans-serif stack.

| Level | Purpose |
| --- | --- |
| 18 px | Application title |
| 16 px | Page title |
| 14 px | Labels and normal content |
| 12–13 px | Help, status, and metadata |
| 11–12 px uppercase | Section and navigation group labels |

Use size and weight before color to create hierarchy. Keep help text at a
readable line height and limit long explanatory lines to a comfortable measure.

## Spacing

Use this editor spacing scale:

- 4 px — tight internal spacing
- 8 px — related controls
- 12 px — normal row spacing
- 16 px — control-group spacing
- 24 px — section spacing
- 32 px — major separation

Do not invent one-off spacing without a layout reason.

## Icons

- Use one icon family for interface actions and page types.
- Use emoji only when emoji is the configured content, not as a substitute for
  interface icons.
- Give every icon-only action a tooltip and accessible name.
- Do not use an icon whose meaning requires persistent explanatory text.

## Empty, loading, and error states

Every data-driven region defines four states:

- Empty
- Loading
- Ready
- Error

Keep the layout stable between states.

Good empty state:

```text
No tile selected
Select a tile to edit its action, label, and icon.
```

Loading must identify what is loading. Errors must state what failed and provide
a recovery action when one exists.

## Scrolling

- Scroll only the region that needs to scroll.
- Keep navigation, search, and global persistence state visible.
- Reset the content region to the top when its selected item or category
  changes.
- Do not nest scroll regions unless each region is independently useful, such
  as a list beside a detail editor.
- Preserve list position when editing an item and returning to the list.

## Responsive behavior

The Editor must remain usable when the window narrows.

- Keep labels with their controls.
- Stack form rows when the label and control no longer fit.
- Stack master-detail layouts when the detail region becomes too narrow.
- Keep primary actions visible.
- Allow long tables to scroll horizontally only when stacking would destroy
  their meaning.
- Do not hide functionality solely to make a narrow layout fit.

## Accessibility

- All functionality must be keyboard accessible.
- Use visible focus states.
- Keep tab order aligned with visual order.
- Associate labels with their controls.
- Provide accessible names for icon-only buttons.
- Do not rely on color alone for status or selection.
- Keep text and control contrast readable in both light and dark themes.
- Announce save, connection, validation, and destructive-action results to
  assistive technology.
- Use sufficiently large click targets for desktop interaction; important and
  frequently used actions receive the largest targets.

## State consistency

Each editor should feel like the same editor in every state:

- Unchanged
- Modified
- Saving
- Saved
- Loading data
- Disconnected
- Error

Change content within stable regions instead of moving unrelated controls.
Preserve user-entered values through transient connection failures and display
refreshes.

## Review checklist

Before shipping an Editor UI change, verify:

1. The current page, item, or Settings category is obvious.
2. The primary task is visually dominant.
3. Shared controls use the standard name and location.
4. The change does not duplicate an existing control.
5. Conditional behavior solves a real problem and does not make configuration
   order unnecessarily important.
6. Help is short by default and detailed only when expanded.
7. Save timing and immediate effects are explicit.
8. Empty, loading, success, and error states are handled.
9. Keyboard, focus, labels, and contrast are correct.
10. Destructive actions are isolated and confirmed.
11. The layout works in light and dark themes and at narrow desktop widths.
12. The interface remains simpler after the change, or the added complexity is
    justified by necessary capability.
