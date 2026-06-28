// ══════════════════════════════════════════════════════════════════════
// AgentNavDropdown.tsx — Accessible dropdown for agent navigation
// ══════════════════════════════════════════════════════════════════════
// Replaces the hardcoded `/agents/data-analyst` nav link.
// Closes on: click outside, Escape key, NavLink click.
// Full ARIA: aria-expanded, aria-haspopup, role="menu".
// ══════════════════════════════════════════════════════════════════════

import { useState, useRef, useCallback } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAgents } from "../api/api.js";
import { useClickOutside } from "../hooks/useClickOutside.js";
import { getStatusConfig } from "../lib/status-config.js";

export function AgentNavDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: agents } = useAgents();
  const location = useLocation();

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close);

  const isActive = location.pathname.startsWith("/agents/");

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1 ${
          isActive
            ? "bg-[var(--accent-blue)] text-white"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
        }`}
      >
        Agent Detail ▾
      </button>
      {open && agents && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md shadow-lg py-1 min-w-[200px] z-50"
        >
          {agents.map((a) => {
            const config = getStatusConfig(a.status);
            return (
              <NavLink
                key={a.name}
                role="menuitem"
                to={`/agents/${a.name}`}
                onClick={close}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-2 text-sm ${
                    isActive
                      ? "text-[var(--accent-blue)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  }`
                }
              >
                <span className={`inline-block w-2 h-2 rounded-full ${config.dotClass}`} />
                {a.label}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}