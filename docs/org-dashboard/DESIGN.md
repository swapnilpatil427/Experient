# Org Intelligence Dashboard — Design Specification

**User-facing product name:** Command Center  
**Document owner:** Marcus Osei (Principal UX Designer)  
**Last updated:** 2026-06-29  
**Status:** Authoritative spec — engineering must implement against this document. Design changes require Marcus's sign-off.

---

## Design Philosophy

Command Center is built on a single conviction: a VP of CX should be able to open this page on a Monday morning and, within 10 seconds, know whether their organization's experience programs are healthy or in trouble. That 10-second window is not a feature — it is the design constraint that governs every decision we make about what to show, what to hide, and how to present it.

The closest design analogs are not other SaaS dashboards — they are aircraft cockpits and network operations centers. These environments have solved the exact problem we are solving: displaying dozens of live data streams to a trained operator who needs to detect anomalies instantly and understand the overall system state at a glance. We take the visual vocabulary of those environments (status lights, health indicators, hierarchical scanning order) and apply it with the polish and accessibility standards expected of a modern enterprise SaaS product.

Density and clarity are not in conflict. The failure of most analytics dashboards is not that they show too much — it is that they show things without hierarchy. Command Center uses three visual weights: hero information (the Org Health Score, the Crystal Brief), supporting context (the KPI row, the trend chart), and reference data (the programs table, topic chips). The user's eye follows this hierarchy naturally. Nothing at the supporting or reference level should ever compete visually with the hero layer.

Dark mode is not an afterthought. "War Room Mode" is a genuine alternative experience designed for crisis situations — when a CX leader needs to run a live response center, project Command Center on a screen, and monitor it for hours. The dark palette is designed for that context: reduced eye strain, higher contrast for critical indicators, and a visual vocabulary that signals "we are in serious mode right now."

---

## Layout System

### Grid

12-column grid with 24px gutters. Breakpoints:
- `sm`: 640px (mobile — single column, core KPIs only)
- `md`: 768px (tablet — 2-column layout, table condensed)
- `lg`: 1024px (desktop — full layout, sidebar appears)
- `xl`: 1280px (wide — programs table at full 8 columns)
- `2xl`: 1536px (ultra-wide — tag group grid expands to 4-column)

### Fixed vs. Scrollable

- **Fixed:** Top Nav / Health Bar (always visible, 64px tall)
- **Fixed:** Sub-filter bar (below top nav, 48px tall, sticks on scroll)
- **Scrollable:** All content below the filter bar

### Component Hierarchy (DOM order = visual scan order)

```
TopNav + HealthBar (fixed)
FilterBar (fixed, below TopNav)
└── CrystalBriefCard (full width)
└── KPIRow (4 tiles, full width)
└── TrendsSection (NPS chart, full width)
└── ProgramsTable (8 col) + AnomalyAlerts sidebar (4 col)
└── EmergingTopics (full width, horizontal scroll)
└── TagGroupGrid (collapsible, full width)
```

On `md` and below, the AnomalyAlerts sidebar moves below ProgramsTable and becomes full-width.

---

## Section Specifications

### 1. Top Nav / Health Bar

**Height:** 64px  
**Position:** Fixed, z-index 50, full viewport width  
**Background:** `bg-white/95 backdrop-blur-sm border-b border-gray-200` (light mode) / `bg-[#0A0F1E]/95 backdrop-blur-sm border-b border-[#1E2A3A]` (dark mode)

**Left zone (logo + org):**
- Xperiq wordmark logo (SVG, 20px tall)
- Separator `|` at 40% opacity
- Org name in `font-semibold text-sm text-gray-900`
- If org name exceeds 24 characters: truncate with ellipsis + tooltip on hover

**Center zone (Org Health Score):**
- Label: `t('orgDashboard.healthScore.label')` — `text-xs text-gray-500 uppercase tracking-wider`
- Score number: `text-3xl font-black tabular-nums` — color-coded (see Color System)
- 30-day sparkline: 80px wide, 20px tall, rendered as a `<canvas>` or minimal SVG path
  - Line color matches the score color (green/yellow/red)
  - No axes, no labels — pure trend signal
- Score label below number: `text-xs font-medium` — "Healthy", "Needs Attention", or "Critical"

**Right zone (actions):**
- "Live" badge: `text-xs font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full` with a 6px pulsing green dot to the left
  - Pulse animation: CSS `@keyframes pulse` — 2s infinite ease-in-out
  - When WebSocket disconnects: badge changes to "Reconnecting..." with amber color and a spinner, no pulse
- Notification bell icon (24px): shows a red dot badge if `totalUnresolved > 0`
- User avatar (28px circle): click opens a dropdown (account, settings, sign out)

**Sub-bar (48px, fixed below TopNav):**
- `bg-gray-50 border-b border-gray-200 px-6`
- Date range picker: `CalendarDateRangePicker` component — default "Last 30 days", options: 7d / 30d / 90d / 1y / Custom
- Tag Group filter: `<select>` styled as Xperiq's dropdown — "All Groups" default, then each tag group name
- Ask Crystal command bar trigger: `⌘K` badge + "Ask Crystal about your org..." placeholder text in a button styled as a fake input field
  - Clicking or pressing ⌘K opens the Crystal command overlay with org context pre-populated

**States:**
- Loading skeleton: TopNav renders at full opacity immediately (static content). The health score number shows a `<Skeleton className="h-8 w-12" />` while the initial API call is in flight.
- WebSocket disconnected: Live badge changes (described above). All real-time-dependent components show a `text-xs text-amber-500` indicator "Live updates paused".
- Health score animating in: Once the API response arrives, the number animates from 0 to its final value using a count-up animation (see Micro-interactions).

---

### 2. Crystal Brief Card

**Width:** Full content width (12 of 12 columns)  
**Background:** Subtle gradient — `bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-100 rounded-xl` (light) / `bg-gradient-to-r from-indigo-950/40 to-purple-950/40 border border-indigo-800/40 rounded-xl` (dark)

**Header:**
- Left: Crystal icon (16px, purple) + `t('orgDashboard.crystalBrief.title')` in `text-sm font-semibold text-indigo-700`
- Right: Date range label in `text-xs text-gray-500` (e.g., "Jun 16–22, 2026")

**Brief body:**
- 2–3 sentence narrative text: `text-base text-gray-900 leading-relaxed`
- Maximum 3 lines before "Read more" expansion — use CSS `-webkit-line-clamp: 3`

**Recommendations list:**
- Numbered list 1–3
- Each item: rank circle (20px, indigo filled) + action text in `text-sm font-medium` + rationale in `text-sm text-gray-500`
- Items with a linked survey: the survey name is an underlined link that navigates to that survey's detail page
- `actionType` icon: investigate (🔍 → use search icon), review (📊 → chart icon), celebrate (⭐ → star icon), monitor (👁 → eye icon)

**Footer:**
- Left: `t('orgDashboard.crystalBrief.lastUpdated', { time: relativeTime })` — `text-xs text-gray-400`
- Right: `t('orgDashboard.crystalBrief.askFollowUp')` CTA button — `variant="ghost" size="sm"` — clicking opens Crystal chat with pre-loaded context: `"org:${orgId} — asking about the weekly brief"`

**Hover state:** Card border brightens from `border-indigo-100` to `border-indigo-300`. Transition 150ms ease.

**Loading/skeleton state:**
- Entire card shows as a skeleton block: `<Skeleton className="h-32 rounded-xl" />`
- Do not flash between "no brief" and "brief loaded" — show skeleton until data arrives, then animate in with a 200ms fade

**Empty state (org too new for a brief — fewer than 3 surveys or fewer than 2 weeks of data):**
- Show a gentle message: `t('orgDashboard.crystalBrief.notEnoughData')` with a progress indicator ("Crystal needs at least 2 weeks of data from 3 programs")
- Do not show an error state — this is an expected new-org state

---

### 3. KPI Row

**Layout:** 4 equal-width tiles in a CSS grid, `grid-cols-4` on `lg+`, `grid-cols-2` on `md`, `grid-cols-1` on `sm`  
**Each tile:** `bg-white border border-gray-100 rounded-xl p-6 shadow-sm`

**Tile 1 — Total Active Surveys:**
- Label: `t('orgDashboard.kpis.activeSurveys')`
- Value: Large integer, `text-4xl font-black tabular-nums text-gray-900`
- Delta: `+3 this month` in `text-xs` with green/red color based on sign

**Tile 2 — Total Responses:**
- Label: `t('orgDashboard.kpis.totalResponses')`
- Value: Formatted large integer (e.g., "12,847"), `text-4xl font-black tabular-nums text-gray-900`
- Sub-label: Live counter — `t('orgDashboard.kpis.responsesToday', { count })` in `text-sm text-green-600 font-semibold tabular-nums`
- This sub-label flashes on WebSocket `response_received` events (see Micro-interactions)

**Tile 3 — Org NPS:**
- Label: `t('orgDashboard.kpis.orgNps')`
- Value: NPS score with sign, `text-4xl font-black tabular-nums` — green if >30, yellow if 0-30, red if <0
- WoW delta arrow: Up arrow (green) or down arrow (red) + `text-sm font-medium` value (e.g., "+4.2 WoW")
- Small NPS gauge arc: SVG half-circle gauge, -100 to +100 range, 80px wide, fills to the current NPS value

**Tile 4 — Avg Sentiment:**
- Label: `t('orgDashboard.kpis.avgSentiment')`
- Value: Score from -1.0 to 1.0, displayed as a percentage mapped to 0-100 for readability (e.g., 0.72 displays as "72 / 100")
- Trend arrow: `improving` → green up, `stable` → gray right, `declining` → red down
- Sentiment bar: thin horizontal progress bar below the value, using the sentiment spectrum colors

**States (all tiles):**
- Loading: entire tile replaced with `<Skeleton className="h-32 rounded-xl" />`
- Hover: `shadow-md border-gray-200` transition 150ms ease
- Click: navigates to the relevant expanded section (Tile 3 → NPS Trends section, smooth scroll)

---

### 4. NPS & Sentiment Trends Chart

**Component:** `NPSTrendChart` — Recharts `ComposedChart`  
**Height:** 280px  
**Width:** Full content width

**Left Y-axis:** NPS range -100 to +100, major gridlines at -50, 0, +50, +100  
**Right Y-axis:** Response volume (auto-scaled to the data range)

**Series:**
- NPS line: solid, 2px stroke, color `#6366F1` (indigo-500) in light mode, `#818CF8` in dark mode
  - Dot on each data point: 4px radius circle, filled white with 2px stroke
  - Active dot on hover: 6px radius, filled with line color
- Response volume bars: `#E0E7FF` fill (indigo-100) in light mode, stacked behind the NPS line on the z-axis
- Industry benchmark line (if configured): dashed, 1.5px stroke, `#9CA3AF` (gray-400), label at right edge "Industry: +XX"

**Hover tooltip:**
- Shows on cursor proximity (within 10px of any data point)
- Content: Date label, NPS value with delta from previous period, response count
- Styled as: `bg-white shadow-lg border border-gray-200 rounded-lg px-3 py-2 text-xs`

**Toggle buttons (top-right of chart):**
- "Aggregated" (default) / "By Survey" — `<ToggleGroup>` component
- "By Survey" mode renders one NPS line per survey (up to 10 lines, color-coded), stacks them on the same chart area
- No more than 10 survey lines at a time — if org has more surveys, show a "showing 10 most active" note

**Live NPS extension:**
When a `response_received` WebSocket event arrives, the rightmost data point of the NPS line updates in place — the line extends slightly rightward if the day's data has changed. Use a Recharts `customized` dot on the live point to show a pulsing indicator.

**Empty state:** Show the chart axes and a centered `t('orgDashboard.trends.noData')` message with a subtle illustration.

---

### 5. Programs Overview Table

**Component:** `ProgramsTable`  
**Columns (in order):** Survey Name | Tag Group | Responses (7d) | NPS | Sentiment | Velocity | Health | Last Activity

**Column specs:**

| Column | Width | Sortable | Notes |
|--------|-------|----------|-------|
| Survey Name | flex-grow | Yes | Truncate at 32 chars, full title in tooltip |
| Tag Group | 120px | Yes | Pill badge with tag group color |
| Responses (7d) | 100px | Yes | Integer, right-aligned |
| NPS | 80px | Yes | Signed integer, color-coded |
| Sentiment | 120px | Yes | Shows trend icon + `improving/stable/declining` label |
| Velocity | 80px | Yes | 0-3x scale shown as 5-segment bar |
| Health | 120px | Yes | `HealthPill` component + 7-day NPS sparkline |
| Last Activity | 100px | Yes | Relative time ("2h ago") |

**HealthPill component:**
- `Healthy` → `bg-green-100 text-green-700 border border-green-200`
- `Attention` → `bg-yellow-100 text-yellow-700 border border-yellow-200`
- `Critical` → `bg-red-100 text-red-700 border border-red-200`
- Right of the pill: 60px sparkline of last 7 NPS daily values (SVG, no axes)

**Row hover state:**
- Row background: `bg-indigo-50/50`
- Right edge of row: "Ask Crystal" inline button appears — `<Button variant="ghost" size="xs">` with Crystal icon and `t('orgDashboard.programs.askCrystal')`
- Clicking "Ask Crystal" opens Crystal command bar pre-seeded with `"survey:{surveyId} — {surveyTitle}"`

**Row click:**
- Triggers a CSS transition: row expands downward to reveal a mini-detail panel (200ms ease-out)
- Mini-detail shows: 30-day NPS sparkline (larger, 200px wide), top 3 topics, latest Crystal insight for this survey
- A "View Full Survey" button navigates to the existing survey detail page
- Alternatively: if the survey has an Insights page, the CTA is "View Insights"
- Clicking the row again collapses the detail panel

**Sort behavior:**
- Default sort: Health status (Critical first), then by Last Activity descending
- Active sort column shows a sort indicator arrow
- Sorting is client-side for up to 50 rows; beyond 50, triggers a new API call with `sort` and `order` params

**Pin-to-top:**
- Hover a row → a pin icon appears at the far left
- Pinned rows stay at the top of the table regardless of sort order, with a subtle `border-l-2 border-indigo-400` left accent
- Pins are persisted in `localStorage` keyed by `org_id` — not server-persisted in Phase 1

**Pagination:** Standard pagination controls below the table. Page size selector: 10 / 25 / 50.

---

### 6. Emerging Topics

**Component:** `EmergingTopics`  
**Layout:** Full-width horizontal scrollable chip row  
**Background:** `bg-gray-50 rounded-xl px-4 py-4 border border-gray-100`

**Topic chip anatomy:**
- Container: `flex items-center gap-2 px-3 py-2 rounded-full border cursor-pointer whitespace-nowrap`
- Default state: `bg-white border-gray-200 text-gray-700`
- Sentiment icon to the left: `😊` positive (>0.3) / `😐` neutral (-0.3 to 0.3) / `😟` negative (<-0.3) — or use colored dot icons to avoid emoji in enterprise UI (Marcus to decide final approach in Figma)
- Topic label: `text-sm font-medium`
- Frequency count: `text-xs text-gray-400 ml-1`

**Chip variants:**
- "New this week" (`isNewThisWeek: true`): blue left border `border-l-2 border-blue-400` + blue dot `w-2 h-2 rounded-full bg-blue-400` before the label
- "Rising" (`frequencyChangePct > 50`): upward arrow icon (green) before the label + green text color for the count

**Chip click — expand drawer:**
- A bottom sheet / slide-in panel appears (400ms ease-out cubic-bezier)
- Content: Topic label as heading, frequency across org, breakdown by survey (bar chart, Recharts), 3 sample verbatim quotes from responses mentioning this topic
- Close via X button, Escape key, or clicking outside

**Scroll behavior:** Mouse users can scroll horizontally. Touch users swipe. Show fade gradients at left/right edges when the chip list overflows.

**Empty state:** `t('orgDashboard.topics.empty')` — "No topics detected yet. Topics appear after 10+ responses."

---

### 7. Anomaly Alerts

**Component:** `AnomalyAlerts`  
**Position:** Right sidebar (4 of 12 columns) alongside ProgramsTable on `lg+`. Full-width below ProgramsTable on `md` and smaller.  
**Background:** `bg-white rounded-xl border border-gray-100 shadow-sm`  
**Header:** `t('orgDashboard.alerts.title')` — `text-sm font-semibold text-gray-900` + unresolved count badge

**Alert item:**
- Left: Severity indicator — vertical bar 4px wide, full item height
  - Critical: `bg-red-500`
  - Warning: `bg-amber-500`
  - Info: `bg-blue-400`
- Content: Survey name in `text-sm font-medium` + detection description in `text-xs text-gray-600` + time ago in `text-xs text-gray-400`
- Actions (appear on hover): 
  - `Resolve` button: `<Button variant="ghost" size="xs">` — marks acknowledged via PATCH endpoint
  - `View` button: `<Button variant="ghost" size="xs">` — navigates to the survey detail page

**New alert animation:** When a `anomaly_detected` WebSocket event arrives, the new alert slides in from the top of the list with a 300ms ease-out transform, and the severity bar pulses once.

**Severity color palette:**
- Critical: `bg-red-500`, `text-red-700 bg-red-50`
- Warning: `bg-amber-500`, `text-amber-700 bg-amber-50`
- Info: `bg-blue-400`, `text-blue-700 bg-blue-50`

**Empty state:**
- Full-width message: `t('orgDashboard.alerts.empty')` — "No anomalies detected — your programs are healthy"
- Illustration: a simple green checkmark shield icon
- This state should feel celebratory, not like a loading indicator

---

### 8. Tag Group Comparison Grid

**Component:** `TagGroupGrid`  
**Default state:** Collapsed — shows a header row with "Tag Groups" label + survey count summary + expand chevron  
**Expanded state:** Grid of cards, `grid-cols-2` on `md`, `grid-cols-3` on `lg`, `grid-cols-4` on `2xl`

**Tag group card anatomy:**
- Card: `bg-white border border-gray-100 rounded-xl p-5 shadow-sm cursor-pointer`
- Group name: `text-sm font-semibold text-gray-900`
- Survey count: `text-xs text-gray-500` — "X surveys"
- Aggregate NPS: large `text-2xl font-black tabular-nums` with color coding
- Top topic: `text-xs text-gray-600 mt-1` — "Top topic: [label]"
- Health pill: `HealthPill` component (same as Programs table)
- 14-day NPS sparkline: full width of card, 40px tall

**Sort options (above the grid):** "By health" (default) / "By NPS" / "By responses" / "By name"

**Card click:** CSS page transition to the Tag Intelligence View (separate page, not in-page). Pass `tagGroupId` as a route param. The transition should feel like drilling down — a slight zoom-in effect.

**Collapse animation:** The grid animates its height from full to 0 with a 200ms ease-in transition. The expand chevron rotates 180°.

---

### 9. Dark Mode / War Room Mode

**Activation:** Toggle in the top-right user menu, labeled `t('orgDashboard.warRoomMode.toggle')`. Persist in `localStorage` as `org_dashboard_dark_mode: boolean`.

**Color palette (CSS custom properties on `:root[data-theme="war-room"]`):**

```css
--bg-primary:     #0A0F1E;   /* deep navy — page background */
--bg-surface:     #111827;   /* slightly lighter — card backgrounds */
--bg-surface-2:   #1E2A3A;   /* borders and subtle separations */
--text-primary:   #F0F4FF;   /* primary text — high contrast on dark */
--text-secondary: #94A3B8;   /* secondary text */
--accent-green:   #00FF88;   /* healthy / positive — neon green */
--accent-amber:   #FFB800;   /* attention / warning — warm amber */
--accent-red:     #FF4757;   /* critical — vivid red */
--accent-indigo:  #818CF8;   /* Crystal / AI elements */
--chart-line:     #818CF8;   /* NPS line in trend chart */
--chart-bar:      #1E2A3A;   /* response volume bars */
```

**Components with dark-mode-specific design (not just color inversion):**
- TopNav: adds a subtle glow to the Org Health Score number using `text-shadow`
- HealthPill: uses neon colors for status — `#00FF88` for healthy, `#FFB800` for attention, `#FF4757` for critical — with a subtle glow filter
- Crystal Brief card: background becomes a dark indigo gradient with a subtle shimmer animation on the card border
- AnomalyAlerts: critical severity indicator becomes a pulsing red glow
- KPI tiles: tile borders become subtle glows matching the tile's status color

**Toggle location:** User menu dropdown, bottom item. Label: "War Room Mode". Icon: a sun/moon toggle icon.

**Toggle animation:** The entire page fades through 50% opacity as the CSS class switches (150ms ease), then fades back in at full opacity. This prevents a jarring flash between themes.

---

## Micro-interactions Specification

### Org Health Score Count-Up Animation

When the initial API response arrives and the health score is first displayed:
- Start: `0`
- End: actual score value
- Duration: `800ms`
- Easing: `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out quart — fast start, decelerate to final value)
- Implementation: `useCountUp(target, duration, easing)` custom hook using `requestAnimationFrame`
- The color of the number also transitions from neutral (`text-gray-400`) to its final color during the animation

### Real-time Response Counter Flash

When a `response_received` event arrives:
- The "responses today" sub-label in the Total Responses KPI tile increments its number
- For 600ms after the increment: the sub-label receives a `bg-green-100 rounded` highlight, then fades back to transparent
- CSS: `@keyframes flash-green` — `0% {background: transparent} 15% {background: #DCFCE7} 100% {background: transparent}`

### NPS Chart Live Extension

When the rightmost data point of the NPS line updates with a new value:
- The line segment from the second-to-last point to the last point re-draws with a 400ms transition
- The live data point dot pulses once (scale 1 → 1.4 → 1, 300ms ease)

### Anomaly Alert Pulse Animation

When a new anomaly alert slides in via WebSocket:
- The severity bar (left edge of the alert) pulses 3 times: opacity 1 → 0.3 → 1 → 0.3 → 1, over 1.5s
- The alert card itself has a 1px border that fades from the severity color to `border-gray-100` over 3 seconds

### ⌘K Command Bar Open/Close Animation

- Open: the command bar overlay fades in at 150ms while simultaneously scaling from `scale(0.97)` to `scale(1.0)` with `transform-origin: center`
- The backdrop: `bg-black/30 backdrop-blur-sm`, fades in at 150ms
- Close: reverse of open, 100ms duration
- The input field is auto-focused on open with a cursor blink

---

## Color System

### Health Score Colors (hex values)

| Score Range | Status | Background | Text | Sparkline |
|-------------|--------|------------|------|-----------|
| 70–100 | Healthy | `#F0FDF4` | `#15803D` | `#22C55E` |
| 40–69 | Needs Attention | `#FFFBEB` | `#B45309` | `#F59E0B` |
| 0–39 | Critical | `#FFF1F2` | `#BE123C` | `#F43F5E` |

### Sentiment Spectrum (gradient, -1.0 to +1.0)

```
-1.0 → -0.6: #DC2626  (red-600)
-0.6 → -0.3: #F97316  (orange-500)
-0.3 → +0.3: #6B7280  (gray-500)
+0.3 → +0.6: #22C55E  (green-500)
+0.6 → +1.0: #15803D  (green-700)
```

### Data Visualization Palette (chart lines, grouped bars)

For multi-survey "By Survey" chart mode — consistent assignment by survey index:
```
Index 0: #6366F1  (indigo-500)
Index 1: #EC4899  (pink-500)
Index 2: #14B8A6  (teal-500)
Index 3: #F59E0B  (amber-500)
Index 4: #8B5CF6  (violet-500)
Index 5: #06B6D4  (cyan-500)
Index 6: #10B981  (emerald-500)
Index 7: #F43F5E  (rose-500)
Index 8: #3B82F6  (blue-500)
Index 9: #A16207  (yellow-700)
```

### Dark Mode Color Overrides

All light mode colors above are replaced by their dark-mode counterparts (defined in the War Room Mode CSS custom properties). Charts use `--chart-line` for primary series and `--bg-surface-2` for secondary fills.

---

## Typography

| Element | Font | Size | Weight | Color |
|---------|------|------|--------|-------|
| Org Health Score (hero number) | System UI / Inter | 2.5rem (40px) | 900 (black) | Dynamic (health color) |
| KPI values | Inter | 2.25rem (36px) | 800 (extrabold) | `gray-900` |
| Chart axis labels | Inter | 0.75rem (12px) | 400 | `gray-500` |
| Table cell text | Inter | 0.875rem (14px) | 400 | `gray-700` |
| Table header | Inter | 0.75rem (12px) | 600 | `gray-500` uppercase |
| Crystal Brief body | Inter | 1rem (16px) | 400 | `gray-900` |
| Crystal recommendation text | Inter | 0.875rem (14px) | 500 | `gray-800` |
| Section headings | Inter | 0.875rem (14px) | 600 | `gray-900` |
| Sub-labels (e.g., "127 today") | Inter | 0.75rem (12px) | 600 | dynamic |

All numeric values use `font-variant-numeric: tabular-nums` to prevent layout shift during live updates.

---

## Accessibility

### WCAG 2.1 AA Targets

All color combinations meet a minimum contrast ratio of 4.5:1 for normal text and 3:1 for large text (18pt or 14pt bold). The War Room Mode palette is specifically designed to exceed 7:1 contrast ratio (AAA level) for all critical information.

### Keyboard Navigation Spec

```
Tab order (left-to-right, top-to-bottom):
1. Xperiq logo link
2. Date range picker
3. Tag Group filter dropdown
4. Ask Crystal trigger (⌘K)
5. Notification bell
6. User menu
7. Crystal Brief card (focusable, Enter navigates to full Crystal chat)
8. "Ask follow-up" button
9. KPI tiles (focusable, Enter scroll to related section)
10. Chart (receives focus; keyboard-navigates data points with arrow keys)
11. Programs table rows (Enter to expand detail; Tab to "Ask Crystal" button)
12. Topic chips (Enter to expand drawer; Escape to close)
13. Anomaly alert items (Tab to Resolve/View buttons)
14. Tag group cards (Enter to navigate to Tag Intelligence View)
```

Arrow key support in the NPS chart: Left/Right arrows move between data points. The active data point shows a focus ring and an aria-label with the full data values.

### Screen Reader aria-label Patterns

```
Org Health Score:
  aria-label="Organization health score: {score} out of 100. Status: {status}. 
               30-day trend: {trend direction}."

KPI Tiles:
  aria-label="Total active surveys: {count}. Change: {delta} this month."
  aria-label="Total responses: {count}. Responses today: {today}."
  aria-label="Organization NPS: {score}. Week over week change: {delta} points."
  aria-label="Average sentiment: {score} out of 100. Trend: {trend}."

HealthPill:
  aria-label="Health status: {status}"

Anomaly Alert:
  role="alert" (for new alerts arriving via WebSocket)
  aria-label="New {severity} anomaly: {description}. In survey: {surveyName}. Detected {timeAgo}."

Crystal Brief:
  aria-label="Crystal's weekly brief for the week of {dateRange}"
  
"Live" badge:
  aria-label="Live data connection active"
  (when disconnected): aria-label="Live data connection interrupted, reconnecting"
```

All interactive elements have a visible focus ring (`outline: 2px solid #6366F1; outline-offset: 2px`) that is not suppressed with `outline: none`.

---

---

## Org Insight History & Manual Summary Generator

*Author: Marcus Osei. Extends §2 (Crystal Brief Card). Per Decision 13 in `DECISIONS.md`, these interaction patterns are internally described using terms like "ambient"/"advanced" — never "futuristic" in any user-facing copy.*

### Design Philosophy Fit

Both capabilities are extensions of the Crystal Brief Card, not new surfaces. A P75 VP of CX should never feel like she left Command Center to "run a report" — she should feel like she's asking Crystal to look further back or dig deeper. Same hero-layer visual weight as the existing brief, same restraint everywhere else.

### Org Insight History

**Layout:** A collapsed strip directly beneath the Crystal Brief Card's footer — `t('orgDashboard.insightHistory.title')` ("Past Briefs") as a ghost-button trigger with a chevron, matching the Tag Group Grid's collapse pattern (§8). Expanding reveals a **vertical timeline**, not a table or calendar — a VP scans "did anything change recently," which is a chronological question, not a lookup question. Calendar view is deferred; flag as a Phase 3+ candidate if usage data shows date-jumping behavior.

**Entry anatomy** (reusing `HealthPill` + typography scale from §5/§8):
- Left rail: a small timeline dot, colored by the org health status *at that time* (green/amber/red) — lets a VP see the org's health trajectory just by scanning the rail top-to-bottom, no reading required.
- Date range label (e.g., "Jun 16–22, 2026") in `text-sm font-semibold`.
- One-line snippet of Crystal's narrative (first sentence, truncated), `text-xs text-gray-500`.
- A type badge, see below.

**Distinguishing scheduled vs. manual:** A `TopicChip`-style pill (§6 pattern): scheduled briefs get an indigo "Weekly Brief" pill with a small clock icon; manual generations get a violet "Custom Summary" pill with a sparkle icon (`auto_awesome`) plus the requester's name on hover via tooltip. Color and icon both differ — never rely on color alone (accessibility). Colors are a dedicated neutral **source** token pair (`--source-scheduled`, `--source-manual`), distinct from the `SeverityBadge` critical/warning/info ramp — provenance is not urgency, and reusing severity colors would train users to misread a "manual" badge as a risk signal (Theo).

**Empty state:** Not an error — "Crystal will save each weekly brief here as it's generated. Your history starts next Monday." No illustration needed; this is a low-drama state.

**Opening an entry:** Click expands the row in place (same 200ms ease-out inline-expand already used for Programs Table rows, §5) rather than navigating away, keeping the VP inside Command Center's flow. Expanded view shows the full narrative + recommendations, identical layout to the live Crystal Brief Card. A **"View as page" permalink** is available per entry for sharing/printing — this is the dedicated, deep-linkable URL Jordan's integration audit requires (routes to a standalone org-scoped report viewer, `EXPERIENCE_ORG_SUMMARY`), reconciling "stay in flow" with "every path needs a shareable, bookmarkable destination."

### Manual Summary Generator

**Trigger:** A single `<Button variant="outline" size="sm">` with a sparkle icon in the Past Briefs strip header, next to the "Past Briefs" toggle: `t('orgDashboard.insightHistory.generateCustom')` ("Generate custom summary"). Not a floating action button and not buried in a menu.

**Date-range picker:** Reuses the existing `CalendarDateRangePicker` from the FilterBar — same component, same interaction, zero new UI vocabulary. Opens in a `Dialog` (shadcn), not a full wizard page like Custom Analysis, because org-level scope has no topic/metric/segment configuration to step through — one input (date range) plus a live preview is enough. Range is capped per the reconciled limit in `DECISIONS.md` (Decision 12); the picker disables dates outside the allowed window rather than allowing a request that will be rejected.

**Preview panel inside the dialog** (mirrors `CustomAnalysisPage`'s preview block): programs included count, response volume in range, estimated credit cost, and a low-data warning if the range predates the org's first 3 surveys. Confirm button: `Button variant="gradient"` — "Generate Summary."

**In-progress state:** On confirm, the dialog collapses into a persistent **status chip** docked at the Past Briefs strip (not a blocking modal — the VP can keep using Command Center while this runs). The chip shows the ambient crystal motif already built for the NL Workflow Builder (`NLThinkingCrystal`, shrunk to ~28px inline, or the CSS-only conic-gradient hex variant at ~24px for zero extra bundle weight) with `crystal-spin` + `pulse-glow`, next to rotating status copy ("Reading 4 programs…" → "Synthesizing trends…" → "Writing your brief…") that changes every ~4s so the wait visibly progresses rather than sitting on a static spinner. **Resolved (Decision 21):** completion is delivered via the existing app-wide `notification_events`/SSE stream, not a new WebSocket hook and not polling as the completion contract — see the full component spec below for exact visual and motion detail.

**Completion notification:** A toast — "Your custom summary is ready" with a "View" CTA — plus the notification bell badge increments. No page reload, no forced navigation.

**Divergence from Custom Analysis precedent:** `CustomAnalysisPage.tsx` has no completion toast today — it silently auto-navigates when polling detects `status === 'completed'`. That works there because the user is pinned to a foreground wizard actively waiting for one report. The org-level generator is deliberately non-blocking (the VP can navigate away mid-generation), so silent auto-navigation isn't available as a completion mechanism — a toast + bell-badge is required, not optional. Log this as its own entry in `DECISIONS.md` once implementation begins, citing "blocking foreground wizard vs. non-blocking backgroundable job" as the rationale for the divergence.

**Landing in history:** The moment it completes, the new entry animates into the top of the Past Briefs timeline with the same 300ms slide-in used for new Anomaly Alerts (§7) — visually reinforcing that manual and scheduled briefs live in one continuous timeline, not two separate systems.

### Ambient / Advanced-Interaction Pass (internal name — see Decision 13 for external framing)

1. **The crystal motif becomes the universal "Crystal is working" signal.** Currently it only appears in the NL Workflow Builder. Extending it to the summary-generation status chip (and, longer term, replacing the generic `hourglass_top` spin in Custom Analysis) gives users one consistent visual grammar for "Crystal is thinking," instead of two competing metaphors for the same concept.
2. **Ambient progress copy over percentage bars.** No fake progress bars — LLM synthesis time isn't linearly predictable. Rotating status sentences instead; a bar that stalls at 90% erodes trust more than honest, changing text.
3. **Non-blocking async by default.** The generator never opens a full-page wizard or blocking modal for its wait state. Forcing a non-analyst to "wait and watch" for up to several minutes is the single most damage-prone moment for perceived reliability; letting her walk away and get a toast later respects her time.
4. **Simplify the KPI Row's Avg Sentiment tile for the P75 user.** Today it shows a raw score, a 0–100 remap, a trend arrow, and a spectrum bar simultaneously. Collapse to a single word + color ("Improving," green) as primary, with the numeric score demoted to a hover tooltip — the VP persona needs the verdict, not the metric.
5. **A single shimmer accent ties Crystal-authored content together.** Apply the existing `shimmer-text` keyframe (already in `CrystalPanel.tsx`) as a one-time 2s pass over any newly-generated brief's headline the first time it's viewed — signals "freshly synthesized" without a badge, purely decorative.

### Per-ICP Fit

- **Sarah (VP of CX, primary):** Works as designed — this is her Monday-morning-plus-ad-hoc-board-request workflow; no variant needed.
- **C-suite (secondary):** Works, but expect them to open entries Sarah generated rather than trigger their own — the requester name on the Custom Summary pill matters more for this persona (trust/provenance).
- **CX Agencies (tertiary):** Needs a variant — history and the generator should be scopable per client org (ties to the Enterprise multi-org view in GTM.md), and generated summaries need white-label-safe styling (no hardcoded Crystal branding) before an agency shares them externally.

### Live-update mechanism — resolved (Decision 21)

Closed by joint Architecture Review (Dariusz, Yuki, Amara, Jordan) after being flagged open across four design rounds: all three cases that needed a live-update answer — generation completion, "Compare to previous" readiness, and the trust/hallucination score arriving after the rest of the brief — are delivered via the existing `notification_events`/SSE stream (`/api/notifications/stream`), keyed by `(org_id, period_key)` where relevant. **No new WebSocket infrastructure (`useOrgDashboardLive`) is needed for any of these flows** — this is a net reduction in planned scope, not just a resolved ambiguity. In-dialog polling may still render cosmetic progress text while the page happens to be open, but it is never the completion contract. Full rationale in `DECISIONS.md`, Decision 21.

---

## Precision Component Specs (added 2026-07-01, Decision 20 — written to Figma-redline precision since Figma access is unavailable; no code accompanies this spec by design)

*Authors: Senior Visual Designer + Motion/Interaction Specialist, hired for this pass. All values are traced to existing codebase constants (hex colors, Tailwind classes, keyframe names) rather than invented, per the house rule of extending the existing design system.*

### 1. Weekly Brief Card (the Hub teaser, added directly beneath `crystalOpening`)

**Layout:** `GlassCard`, full-width, `p-5 rounded-2xl`, background `bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-100`, shadow `0 4px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.9)` (exact `SurveyCard` shadow value). Eyebrow row: `Icon name="auto_awesome" size={13}` color `#8329c8` + `text-[10px] font-black uppercase tracking-widest text-on-surface-variant` reading "Crystal's Weekly Brief for {org}", date range right-aligned `text-[10px] text-on-surface-variant/55`. Collapsed narrative: `text-sm text-on-surface leading-relaxed`, `line-clamp-1` desktop / `line-clamp-2` mobile, chevron-expand `Icon name="expand_more" size={14}` right-aligned. Expanded: narrative un-clamps; `mt-3 pt-3 border-t border-outline-variant/20`; numbered recommendations (20px rank circle `bg-[#8329c8] text-white text-[10px] font-black` + action `text-sm font-medium` + rationale `text-xs text-on-surface-variant`); footer with last-updated timestamp + "Ask a follow-up" (`Button variant="ghost" size="sm"`) + "View full Command Center" (`Button variant="outline" size="sm"`). Hover: border `border-indigo-100` → `border-indigo-300`, 150ms. Empty: muted `auto_awesome` icon at 24px + `text-xs text-on-surface-variant`, no chevron. Error: `Icon name="error_outline" size={14}` `#b41340` + retry ghost button.

**Motion:** expand/collapse via Framer Motion `layout` on the container (not measured-height JS — content is simple enough that `layout` avoids a second measurement pass), 300ms, **house curve `[0.22, 1, 0.36, 1]`**. Narrative cross-fades to the full text + recommendations (opacity 0→1, 150ms, starting 50ms into the height animation so text doesn't pop before the container has room) — recommendations mask-reveal with the expanding container, no independent slide. Chevron rotates 180° over the same 300ms. **Reduced motion:** instant height/opacity swap, no `layout` animation; chevron is an instant icon-state swap, no rotation transform.

### 2. Tag Groups Strip (at-risk tag groups only)

**Layout:** section header matches §3 Live Intelligence exactly (pulse dot colored by worst status present, `text-[10px] font-black uppercase tracking-widest` "AT-RISK TAG GROUPS"). Cards: `GlassCard p-4 rounded-xl`, horizontal `flex gap-3` desktop/tablet (wraps, never scrolls), `flex-col` mobile; fixed `w-56` desktop / `w-full` mobile. Collapsed content: `HealthPill`-style badge top-right (amber `#d97706` or red `#b41340`, `${color}14` background), tag name `text-sm font-bold truncate`, survey count `text-[10px] text-on-surface-variant/60`. Expanded (appended below, collapsed content stays static and visible): aggregate NPS `text-2xl font-black` via the unified health palette, top topic `text-xs text-on-surface-variant`, single CTA `Button variant="outline" size="sm"` "View Tag Report" — the only exit, full navigation. Default border `border-outline-variant/20`; hover `border-primary/30` + `shadow-md`, 150ms; expanded adds `bg-surface-container/40` fill. Empty/error: section does not render at all (no card, no message).

**Motion:** `AnimatePresence` + `motion.div` (`height:0,opacity:0` → `height:'auto',opacity:1`), 200ms ease-out, matching the Programs Table precedent exactly — a discrete append, not a continuous measurement, so no `layout` prop needed. Collapsed content never swaps or hides; the expand strictly appends new content below it. **Reduced motion:** instant show/hide of the appended block, opacity-only, no height animation.

### 3. Generation Status Chip ("Ask Crystal for a Brief," in progress)

**Layout:** docked pill, `inline-flex items-center gap-2.5 px-3 py-2 rounded-full`, background `rgba(131,41,200,0.08)`, border `1px solid rgba(131,41,200,0.18)`. Crystal motif: CSS-only conic-gradient hex variant (`app/CLAUDE.md`'s existing pattern), scaled to 24px, same three-layer structure. Status text `text-xs font-semibold text-[#8329c8]`. States: *in-progress* (default, as above); *reconnecting* (motif keeps spinning, text turns `text-amber-600` "Reconnecting…", reusing the app-wide disconnected-Live-badge pattern); *failure* (motif replaced by `Icon name="error_outline" size={16}` `#b41340`, text becomes an underline-on-hover text-button "Crystal couldn't finish this summary — Try again"); *timeout* (motif keeps spinning, text turns `text-on-surface-variant` "This is taking longer than expected…"). No dismiss affordance while running; the chip itself disappears on completion, replaced by the toast.

**Motion:** status text rotates every 4s via overlapping cross-fade (old string fades out over the first 150ms of a 300ms window while the new string fades in over the last 150ms — never a blank gap), `ease-in-out`. The ambient motif reuses `crystal-spin 4s linear infinite` (confirmed call site `CrystalPanel.tsx:2182`) and `pulse-glow 2.5s ease-in-out infinite` (confirmed `CrystalPanel.tsx:1469`, `index.css:266`) **unchanged** — keyframe timing is resolution-independent, only the element shrinks. Ready-state transition: orb + status text cross-fade out over 250ms while real content fades+slides in (`y:8→0`, opacity 0→1, 300ms, house curve), overlapping by ~100ms, matching the app's standard `AnimatePresence` exit/enter overlap convention. **Reduced motion:** orb renders as a static glyph (never spins/pulses); status text changes are instant swaps, no cross-fade; ready-state transition becomes a plain opacity crossfade with no y-slide.

### 4. CheckpointDiffPanel ("Compare to previous") — previously unspecified, now complete

**Layout:** trigger is a ghost text-button inside an already-expanded Brief Archive entry only (`text-xs font-medium text-primary` "Compare to previous" + `Icon name="compare_arrows" size={13}`); never renders if `parent_checkpoint_id` is null. Panel: `GlassCard p-5 rounded-xl mt-3`, `border border-outline-variant/20`, inserted inline below the entry (not a modal). Desktop/tablet (≥768px): `grid grid-cols-2 gap-4`, each side a sub-card `bg-surface-container/40 rounded-lg p-4` with eyebrow "PREVIOUS"/"CURRENT" + date, and a single-word verdict `text-lg font-black` via the unified health palette — no full delta table inline. Mobile (<768px): sequential stack — Before card, then After card, then the delta, never a compressed two-column layout. Delta indicator (new primitive, signed-value pill): `px-2.5 py-1 rounded-full text-xs font-bold tabular-nums`, positive `text-[#059669] bg-[#05966914]` + `arrow_upward`, negative `text-[#b41340] bg-[#b4134014]` + `arrow_downward`; raw numeric deltas demoted to a tooltip. Loading: paired skeleton cards (`h-24 rounded-lg bg-surface-container animate-pulse`), fetched lazily only on click. Error: inline within the panel, never collapses the parent entry.

**Motion:** enters via the same 200ms ease-out inline-expand as its parent Brief Archive entry — no separate entrance animation layered on top, to avoid double-motion. Before/after columns animate in **simultaneously** (not staggered by side — staggering would falsely imply one side matters more), each using the standard `rise` variant (`y:16→0`, 0.4s, house curve) with `staggerChildren: 0.05` *within* each column only (row-by-row). The delta pill draws attention via a single one-shot scale pulse on mount (`scale: 0.8→1.08→1`, 400ms, house curve) plus a color fade-in from neutral to its signed color — never a looping animation, consistent with "verdict surface, not audit surface." **Reduced motion:** panel appears via instant opacity swap (no y-motion, no stagger); the delta pill skips the scale pulse, appearing at final scale with only a color fade.

---

## Trust, Citation & Comparison UI — Progressive Disclosure Spec (added 2026-07-01, Decision 16)

*Authors: Marcus Osei, Sofia Reyes, Theo Bergmann, following a full-design review. Binding scope per the footer below — this is not optional polish.*

**The governing rule:** the Crystal Brief Card is a verdict surface, not an audit surface. Citation, trust-scoring, and comparison affordances are all evidence-inspection tools for the rare moment a user wants to dig in — none of them may add visual weight to the primary, at-rest reading experience. The review found that stacking these naively (a citation chip + a trust badge + a diff view, all inline) turns a 3-second glance into an audit, which directly undermines the product's core promise.

**Trust/confidence signaling:**
- Reuse the existing `ConfidenceChip` component and its Reliable/Indicative/Low-signal visual language (`app/src/pages/insights/shared.tsx`) — do not invent a new trust-token system for org scope. Map `hallucination_score`'s `pass`/`flag`/`fail` verdicts onto the existing three tiers.
- **Never render a "pass" state inline.** A visible "verified" badge on every sentence trains the user to hunt for its *absence* as the tell for a problem — that replaces confidence with vigilance, the opposite of the product's promise. Only surface a chip when the verdict is `flag` or `fail`.
- **Banned/required copy (Sofia):** never say "hallucination," "low confidence," or "unverified" to a VP — these read as something being broken. Use **"Crystal's best read"** or **"Early read — based on limited data so far"** for flagged claims, framed as informational, not a warning. If a hover/expand shows an exact score, label it **"How sure is Crystal?"**, never "confidence score" or "trust score" — both sound like grading the AI, which invites doubt that didn't need inviting.

**Citations:**
- Stay click-to-reveal, exactly as the existing `CitationChip` already behaves — no added visual weight in the untouched state. Collapse multiple citations on one recommendation to a single "1 source" / "3 sources" affordance rather than one chip per citation.

**"Compare to previous" (checkpoint diff view):**
- Lives only inside an already-expanded Brief Archive entry — never a default-visible control on the live Crystal Brief Card. It is explicitly a "did anything change" query, which is analyst behavior, and belongs at the same disclosure depth as history itself, not the primary read.
- **Full component spec now complete** — see "Precision Component Specs," item 4, above (layout, states, and motion, including the new signed-value-pill delta indicator).
- When it ships, prefer a single-word/color verdict per side (matching the existing "Improving, green" simplification pattern from the Ambient/Advanced-Interaction Pass above) over a full delta table — demote raw numeric deltas to hover/expand.

---

## Navigation Strategy: Org → Tag → Survey → Response (added 2026-07-01, Decision 17; landing design revised and closed out 2026-07-01, Decision 18)

*Authors: Priya Rajan, Marcus Osei (design), Morgan and Sam of Tag Report (joint sign-off, Decision 18). The cross-team item is now resolved — see "Resolved: additive integration" below.*

### Landing: strictly additive, verified against the shipped page

**Superseded design note:** an earlier version of this section proposed role-conditionally *replacing* `crystalOpening` with Command Center's hero. The stakeholder overrode this with a hard constraint, verified directly against the shipped `app/src/pages/experience/ExperienceHubPage.tsx` (962 lines): no existing content may be removed, hidden, or replaced for any user. `crystalOpening` and the existing NPS-headline, KPI strip, Live Intelligence feed, Survey Grid, and Capability layers sections (§1–§5) are untouched, unconditionally, for every viewer. Everything below is a pure insertion.

- **Org Health Score** → a 5th tile in the existing KPI grid (`grid-cols-2 md:grid-cols-4 lg:grid-cols-5`), reusing `KpiTile` verbatim.
- **Crystal's Weekly Brief** → a new card inserted immediately after the existing `crystalOpening` paragraph (which keeps full, unconditional, primary-hero weight for everyone). The Brief card: distinct existing gradient/border card styling (not a new style), an explicit "Crystal's Weekly Brief for [org]" eyebrow label, and **visually subordinate weight** to `crystalOpening` (e.g. collapsed-to-one-line with an expand affordance) — one primary hero voice per viewer, always `crystalOpening`; the Brief is a clearly-labeled secondary artifact.
- **Tag Groups strip** → a new section between the existing §3 (Live Intelligence) and §4 (Survey Grid). Hard-scoped **at the data layer** to `health_status != healthy` tag groups only (never a general tag browser); inline-expand shows aggregate NPS + top topic; its only exit is a single CTA doing full navigation to the existing Tag Report route — never duplicating Tag Report's multi-metric/provenance machinery inline.
- **Role-gating** applies only to whether these three new elements render, using the exact permission check that already gates Tag Report access today — no new parallel permission system. Existing content is unconditional for all viewers regardless of role.

### Drill-down: inline-expand vs. navigate

**Rule of thumb:** inline-expand when the interaction answers "is this worth my attention"; full navigation only when the destination is a genuinely separate trust/audit surface.

- **Org hero → Tag Group:** an at-risk tag group renders as a `HealthPill`-badged card in a new Tag Groups strip (same collapsed-by-default pattern as Brief Archive). Clicking **inline-expands** (200ms, matching the existing Programs Table / Brief Archive pattern) to show aggregate NPS, top topic, and a "View Tag Report" CTA — giving the answer to "should I care" without leaving the page.
- **Tag Report → Survey:** the CTA click, and only the CTA click, is a full page navigation into the Tag Report (`/app/experience/tags/:tagId/report`) — Tag Report's own disclosure/backfill/multi-metric machinery is a distinct trust surface that must not be embedded inline (this is Appendix C's own correct reasoning; do not re-litigate it by cramming it into a hover card).
- **Survey → Response:** from Tag Report's provenance panel, drilling into a contributing survey's own Insight Trail and onward to a Response Detail citation is likewise full navigation — a citation trail is its own reading context, not a hover payload.

**Shortcut (skip the Tag Report hop when possible):** Org Brief recommendations already carry a nullable `survey_id` alongside `tag_group_id` (ARCHITECTURE.md). When `survey_id` is populated — the common case, per `generate_recommendations`' own selection logic — navigate directly from the recommendation to that survey's Insight Trail. Tag Group is the fallback path only when `survey_id` is null. This avoids forcing a wasted intermediate click for the single most common recommendation shape.

### Checkpoint-diff scope boundary

`CheckpointDiffPanel` (fully specified per "Precision Component Specs" above) stays **Org-level only** for now. Tag Report already has its own, differently-shaped comparison primitive (Bracketed Snapshot / Custom Range, `tag-report/DESIGN.md` §4.3) — do not force these to converge before the Org-level diff view has even shipped and proven its interaction pattern out. Revisit as a fast-follow only after that.

### Accessibility requirement before ship

`HealthPill`'s status palette and `npsColor()`'s thresholds (used by `SurveyCard`) are not currently unified. Stacking Org health + Tag Group health + Survey portfolio health on one page — especially on mobile, single-column — risks a colorblind/low-vision user being unable to tell which "red" belongs to which hierarchy level, since each currently uses a different hex for the same semantic status. **Audit and unify the palette across both before this ships**, and ensure every status indicator carries a text/icon redundant to color, not just `HealthPill` (`SurveyCard`'s NPS color coding currently does not).

### Resolved: additive integration, jointly signed off (Decision 18)

The cross-team item is closed. Morgan and Sam (Tag Report's Product Owner and UX Designer) both reviewed the revised, strictly-additive design above and returned **APPROVE WITH CONDITIONS** — all conditions are incorporated into the spec above (subordinate Brief styling with explicit label, data-layer-scoped Tag Groups strip, reused permission check, CTA-only exit to the real Tag Report). Morgan flagged one metric to watch post-launch: if Tag Report's own drill-down/backfill-disclosure engagement rate (DESIGN.md §5) drops after this ships, that's the signal the Tag Groups strip became real competition for the Reports tab rather than a teaser, and this decision should be revisited. Full sign-off record: `docs/org-dashboard/DECISIONS.md`, Decision 18.

**Out of scope (stakeholder decision, 2026-07-01):** a multi-org switcher for CX agencies is explicitly not part of this design. The CX agency ICP (GTM.md tertiary) does not get its own Command Center variant in this phase — role-gating for the additive elements above applies only to the single-org internal-admin case. Revisit agency support as a separate, later scope decision if/when it becomes a priority; do not design around it speculatively until then.

### The full Command Center lives at its own route — resolved gap from the last review

The Hub (`/app/experience`) only ever shows teasers (5th KPI tile, subordinate Brief card showing the latest brief only, at-risk-only Tag Groups strip) — this was deliberate per Decision 18's "keep the Hub light" conditions. The full, dense experience — complete Health Score breakdown, full Weekly Brief with all recommendations, **Brief Archive** (full chronological history, both scheduled and manual), **"Ask Crystal for a Brief"** (the manual generator), the **full** Tag Intelligence grid (all tags, not just at-risk), the Program Alerts panel, and Checkpoint Compare — lives at `/app/experience/org/trends` (promoting the existing `OrgTrendsPage` stub). Reached via the Org Health tile, the Brief card's "View full Command Center" CTA, or (for tag drill-down specifically) the Tag Groups strip's "View Tag Report" CTA, which goes to Tag Report's own page instead, not this one.

---

## Failure States (added 2026-07-01)

*Every failure state below follows the same principle as the rest of this spec: never silently hide a problem, never alarm the user with clinical language, never block on a failure that doesn't need to block.*

| Surface | Trigger | Customer sees |
|---|---|---|
| Org Health tile / Weekly Brief card (Hub or full page) | API/network error loading the brief or score | Neutral inline state: "Couldn't load your Org Health Score right now" + Retry — distinct from the empty-state ("Crystal hasn't written a brief yet"), never confused with it |
| Any cached/stale-serving scenario | Cache TTL window where `hallucination_score`/lineage fields haven't landed yet (per the cache-invalidation-ordering note in Addendum 2) | A subtle "as of [time]" freshness marker — never presented as if freshly computed when it isn't |
| Manual Summary — credit check | `402 INSUFFICIENT_CREDITS` | Caught at the **preview** step, before generation starts (the preview already shows estimated cost) — inline in the dialog: "You don't have enough credits for this range." + reduce-range / upgrade options |
| Manual Summary — rate limit | `429 RATE_LIMITED` | "You've reached today's limit for custom summaries. Try again tomorrow, or view your Brief Archive." |
| Manual Summary — generation fails server-side | `agent_runs.status = 'failed'` | The docked status chip transitions from "Reading 4 programs…" to a neutral failure state ("Crystal couldn't finish this summary — Try again") **plus** a toast (the user may have navigated away, per the non-blocking design) |
| Manual Summary — timeout | 600s cap exceeded | Distinct copy from a hard failure: "This is taking longer than expected — Crystal will notify you when it's ready, or try a shorter range." |
| Grounding-completeness verdict = `fail` (not just one flagged claim, the whole brief) | `verify_and_score` pass 3 fails broadly | Per Decision 16, publish is never blocked — but the whole card gets the "Crystal's best read" treatment rather than a single flagged citation, i.e. "Crystal's early read — some of this week's data is still being verified," not silently presented as fully verified |
| `INJECTION_DETECTED` canary fires | Prompt-injection attempt via a compromised headline (see ARCHITECTURE.md's Trust-boundary collapse section) | This is a security failure, not a content-quality one — that generation attempt is discarded, retried once automatically; if it fires twice, fall back to a plain numbers-only template narrative for that period. The customer never sees any trace of the injection attempt or a scary error — fail open to the safe degraded mode silently |
| Citation click-through 404 | Cited insight/response deleted or superseded since brief generation (including GDPR erasure via the redaction hook) | Land on the survey's Insights view with an inline note ("This specific citation is no longer available"), never a raw 404 |
| "Compare to previous" with no comparable prior checkpoint | `parent_checkpoint_id` is null (first brief ever, or a lineage gap) | The action simply doesn't render — not an error state, consistent with the Tag Groups strip's "if nothing qualifies, don't render the affordance" pattern |
| Tag Groups strip fails to load, or health status can't be determined | API error on the teaser query | Fail silently — don't render the section at all, rather than showing a broken card on the primary landing page (extends the existing "if all tags are healthy, don't render" precedent) |
| Live-update channel disconnects mid-generation | WebSocket/notification-events connection drop (mechanism still pending Architecture Review — see cross-team open item) | Falls back to the existing 5s single-job polling already specified; if that also fails, the status chip shows "Reconnecting…" reusing the app-wide "Live" badge disconnected pattern (`app/CLAUDE.md`), never silently goes stale with no indication |

---

## Responsive Design (added 2026-07-01)

*Grounded in the app's existing three-breakpoint system (`useBreakpoint()`: Mobile <768px, Tablet 768–1023px, Desktop ≥1024px) and its no-horizontal-scroll rule — no new responsive pattern is introduced where an existing one already covers the case.*

**Hub KPI strip (now 5 tiles):** Desktop `grid-cols-5`. Tablet stays `grid-cols-4`, wrapping to a 4+1 second row rather than compressing tile width. Mobile stays `grid-cols-2` (the existing pattern) — the 5th tile wraps to its own full-width row (`col-span-2`) rather than introducing a horizontal-scroll carousel, which would violate the project's no-horizontal-scroll rule for the sake of one orphaned tile.

**Weekly Brief card (Hub teaser):** already full-width and vertical by construction — no layout change needed across breakpoints; collapsed-state truncation moves from 1 line to 2 on mobile, where there's more vertical room relative to width.

**Tag Groups strip:** Desktop/tablet render as a horizontal row of cards. **Mobile reflows to a vertical, full-width stack** — a "strip" cannot stay horizontal under 768px without violating the no-horizontal-scroll rule, so this is a genuine layout change, not just a reflow of the same DOM.

**Full Command Center page (`/app/experience/org/trends`):**
- Health Score component breakdown: desktop uses hover-reveal; **mobile has no hover, so this becomes tap-to-expand** — an accessibility-driven change, not cosmetic.
- Brief Archive timeline: vertical by design already, works unchanged on mobile; expanded entries drop to single-column content (no internal side-by-side) below 768px.
- Manual Summary Generator: uses shadcn `Dialog` on desktop/tablet; **on mobile, use `Sheet` instead** (already an available primitive), consistent with how the app already prefers bottom-sheet patterns over centered dialogs on small screens — branch on `useBreakpoint()`, not a CSS-only media query, since the two are different components.
- Full Tag Intelligence grid: same grid → vertical-stack reflow as the Tag Groups strip.
- Program Alerts panel: a list — reflows to full-width naturally, no special-casing needed.
- **Checkpoint Compare (`CheckpointDiffPanel`) — fully specified, see "Precision Component Specs" above:** desktop/tablet use a two-column before/after layout; **mobile cannot do side-by-side at all** (two columns of numbers don't fit under 375px) — it becomes a **sequential stacked layout: Before card, then After card, then the delta**, not a compressed version of the two-column layout.

**Response Detail viewer:** a standard page-level route; follows the existing `AppShell`/`PageHeader` responsive conventions already used everywhere else — no new pattern required.

---

## Loading States (added 2026-07-01)

| Component | Loading treatment |
|---|---|
| 5th KPI tile (Org Health Score) | Reuses `KpiTile`'s existing skeleton (`h-[112px] rounded-2xl bg-surface-container animate-pulse`) verbatim — no new skeleton needed |
| Weekly Brief card (Hub teaser + full) | New skeleton matching its own aspect ratio (label placeholder + 2-line text placeholder) — does not reuse `KpiTile`'s shape, since the card is a different proportion |
| Tag Groups strip | Reuses the existing Live Intelligence feed's skeleton pattern verbatim (`h-16 rounded-xl bg-surface-container animate-pulse`, 2–3 shown) |
| Brief Archive — initial load | 3–4 skeleton timeline rows (dot + 2-line placeholder) |
| Brief Archive — pagination / "load more" | A single small spinner appended at the bottom of the existing list only — never a full-list skeleton re-render, consistent with the cursor-pagination design ("reload re-fetches only the first page and prepends") |
| Manual Summary dialog — cost/corpus preview | Skeleton line where cost/response-count/warnings will appear; **the Generate button stays disabled until the preview resolves** — never allow confirming against a stale or loading estimate |
| Manual Summary — generation in progress | Already fully specified (the ambient-crystal status chip with rotating text) — this **is** the loading state for the whole generation flow |
| Checkpoint Compare | Skeleton placeholder card(s) (two side-by-side on desktop, stacked on mobile per the responsive spec above) while the compare endpoint resolves; the Brief Archive entry itself is already rendered and interactive before this loads — compare is fetched lazily only on click, never blocking the entry's own expand |
| General rule | Every skeleton/pulse loading state must respect `prefers-reduced-motion` per the app's existing convention — plain opacity-pulse skeletons are acceptable under reduced motion, but no new shimmer/gradient-sweep loading effect may be introduced without a reduced-motion fallback |

---

*This design specification is the contract between Design and Engineering. No UI component within Command Center may ship to production without matching this specification. Deviations require Marcus's written sign-off and a DECISIONS.md entry explaining the rationale.*
