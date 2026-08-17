# TransitHub — Mobile Phone Web Patch

## What's fixed

Your CSS already had the right classes (`mob-header`, `mob-nav`, etc.) but the JSX never rendered them.
This patch adds:

1. **`MobileHeader` component** — sticky top bar with logo + user info
2. **`MobileBottomNav` component** — fixed bottom tab bar  
3. **Wired into `EmployeeShell`** — replaces hidden sidebar on mobile
4. **Wired into `AdminDashboard`** — 5-tab bottom nav for admin (My Transport + key admin tabs)
5. **`main-area` padding fix** — content clears the header + bottom nav on mobile

---

## Step 1 — Add these two components (paste before `EmployeeShell`)

```jsx
// ════════════════════════════════════════════════════════════════════════════
// MOBILE HEADER + BOTTOM NAV
// ════════════════════════════════════════════════════════════════════════════
function MobileHeader({ title, subtitle, userName, empId }) {
  return (
    <div className="mob-header">
      <div className="mob-header-left">
        <div style={{
          width: 32, height: 32, borderRadius: 9,
          background: "rgba(0,180,216,.22)",
          display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <Ico n="bus" s={18} c={C.cyan} />
        </div>
        <div>
          <div className="mob-header-title">{title || "TransitHub"}</div>
          {subtitle && <div className="mob-header-sub">{subtitle}</div>}
        </div>
      </div>
      <div className="mob-header-user">
        <div className="mob-header-name">{userName}</div>
        <div className="mob-header-id">{empId}</div>
      </div>
    </div>
  );
}

function MobileBottomNav({ items, active, onChange }) {
  return (
    <nav className="mob-nav">
      {items.map(([id, label, icon]) => (
        <button
          key={id}
          className={`mob-nav-item${active === id ? " active" : ""}`}
          onClick={() => onChange(id)}
        >
          <Ico n={icon} s={20} c={active === id ? C.cyan : "rgba(255,255,255,.45)"} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
```

---

## Step 2 — Replace `EmployeeShell`

```jsx
function EmployeeShell({ user: init, onLogout }) {
  const [page, setPage] = useState("apply");
  const [user, setUser] = useState(init);

  const NAV = [
    ["apply",   "Apply",   "form"],
    ["roster",  "Roster",  "cal" ],
    ["profile", "Profile", "user"],
  ];

  return (
    <div className="shell">
      {/* Desktop sidebar (hidden on mobile via CSS) */}
      <div className="sidebar">
        <div className="sb-logo">
          <div className="sb-logo-icon"><Ico n="bus" s={20} c={C.cyan} /></div>
          <div><div className="sb-logo-title">TransitHub</div><div className="sb-logo-sub">Employee</div></div>
        </div>
        <div className="sb-user">
          <div className="sb-user-name">{user.name}</div>
          <div className="sb-user-id">{user.empId}</div>
        </div>
        <div className="sb-div" />
        <div className="sb-nav">
          {NAV.map(([id, lbl, icon]) => (
            <button key={id} className={`sb-item${page === id ? " active" : ""}`} onClick={() => setPage(id)}>
              <Ico n={icon} s={15} />{lbl}
            </button>
          ))}
        </div>
        <div className="sb-spacer" />
        <div className="sb-bottom">
          <button className="sb-item" onClick={onLogout}><Ico n="logout" s={15} />Sign Out</button>
          <div style={{ padding: "10px 12px 4px", fontSize: 10, color: "rgba(255,255,255,.25)", textAlign: "center" }}>© 2026 SACI. All Rights Reserved.</div>
        </div>
      </div>

      {/* Mobile header (visible only on mobile via CSS) */}
      <MobileHeader
        subtitle="Employee"
        userName={user.name}
        empId={user.empId}
      />

      {/* Page content */}
      <div className="main-area">
        {page === "apply"   && <TransportForm user={user} />}
        {page === "roster"  && <RosterPage user={user} onUserUpdate={setUser} />}
        {page === "profile" && <ProfilePage user={user} onUpdate={setUser} />}
      </div>

      {/* Mobile bottom nav (visible only on mobile via CSS) */}
      <MobileBottomNav
        items={[
          ...NAV,
          ["logout", "Sign Out", "logout"],
        ]}
        active={page}
        onChange={(id) => {
          if (id === "logout") onLogout();
          else setPage(id);
        }}
      />
    </div>
  );
}
```

---

## Step 3 — Replace `AdminDashboard`'s render return (add mobile nav/header)

Inside `AdminDashboard`, find the `return (` and replace the outer `<div className="shell">` wrapper + its contents to add:

**After the existing `<div className="sidebar">...</div>` block, and before `<div className="main-area">`, add:**

```jsx
      {/* Mobile header */}
      <MobileHeader
        subtitle={isSuperAdmin ? "Super Admin" : "Team Leader"}
        userName={adminUser?.name || "Administrator"}
        empId={adminUser?.empId || "ADMIN"}
      />
```

**After `</div>` that closes `<div className="main-area">`, add:**

```jsx
      {/* Mobile bottom nav — 5 key tabs */}
      <MobileBottomNav
        items={[
          ["apply",   "Apply",    "bus"    ],
          ["routes",  "Routes",   "route"  ],
          ["dinner",  "Dinner",   "dinner" ],
          ["apps",    "Apps",     "form"   ],
          ["settings","Settings", "settings"],
        ]}
        active={tab}
        onChange={setTab}
      />
```

---

## Step 4 — CSS fix: `main-area` on mobile

In the CSS string (`const CSS = \`...\``), find the `@media(max-width:768px)` block and update `.main-area`:

```css
/* CHANGE THIS line in the media query: */
.main-area{padding:14px 12px 80px;min-height:calc(100vh - 56px - 62px)}

/* TO: */
.main-area{padding:calc(56px + 14px) 12px 80px;min-height:100vh}
```

This adds `56px` top padding (= mobile header height) so content starts below the sticky header, and `80px` bottom padding so the last card clears the bottom nav.

---

## Step 5 — Make admin "All tabs" accessible via mobile

The mobile bottom nav only shows 5 tabs. To let admins reach `roster`, `profile`, `import`, `employees`:
add a **"More" option** that opens a sheet, OR simply add them to the `settings` tab with links.

The simplest approach — add a "More" tab that cycles through remaining tabs:

```jsx
// Replace the MobileBottomNav in AdminDashboard with:
<MobileBottomNav
  items={[
    ["apply",     "Apply",   "bus"     ],
    ["routes",    "Routes",  "route"   ],
    ["dinner",    "Dinner",  "dinner"  ],
    ["apps",      "Apps",    "form"    ],
    ["employees", "Team",    "team"    ],
  ]}
  active={tab}
  onChange={setTab}
/>
```

And add a small "More admin tools →" link inside the Settings tab content so TLs/SA can still reach `import`, `settings`, `roster`, `profile` on mobile.

---

## Summary of changes

| File area | Change |
|---|---|
| New components | `MobileHeader`, `MobileBottomNav` added before `EmployeeShell` |
| `EmployeeShell` | Renders `MobileHeader` + `MobileBottomNav` |
| `AdminDashboard` return | Renders `MobileHeader` + `MobileBottomNav` |
| CSS `.main-area` media query | Top padding includes header height (`56px + 14px`) |
| No logic changes | All existing state, DB calls, routing unchanged |
