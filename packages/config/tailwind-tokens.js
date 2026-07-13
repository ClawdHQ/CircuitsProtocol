/** Shared ClawdHQ design tokens — single source of truth for colors used in
 * both Tailwind's @theme (apps/web/src/app/globals.css) and JS contexts
 * (chart colors, dynamic chain badges, etc.) where Tailwind classes can't reach. */
module.exports = {
  background: {
    primary: "#08080E",
    surface: "#0F0F18",
    elevated: "#14141F",
  },
  glass: "rgba(255,255,255,0.04)",
  border: {
    subtle: "rgba(255,255,255,0.07)",
    strong: "rgba(255,255,255,0.14)",
  },
  accent: {
    violet: "#7C3AED",
    cyan: "#06B6D4",
  },
  state: {
    emerald: "#10B981",
    amber: "#F59E0B",
    red: "#EF4444",
  },
  chain: {
    bsc: "#F3BA2F",
    base: "#0052FF",
    eth: "#627EEA",
    solana: "#9945FF",
    sui: "#4CA3FF",
  },
  text: {
    primary: "rgba(255,255,255,0.93)",
    secondary: "rgba(255,255,255,0.55)",
    tertiary: "rgba(255,255,255,0.28)",
  },
};
