import { type ReactNode, useId } from 'react'

/*
 * The built-in agents' marks, from LobeHub Icons (@lobehub/icons-static-svg 1.95.1, MIT,
 * https://github.com/lobehub/lobe-icons), in their brand colors where the set has them.
 * Each sits on a black tile (agent-icon.tsx): Codex and Kiro without their own square
 * behind them, Kiro's ghost in its purple. Grok, OpenCode and Pi are one-color marks and
 * take the tile's text color. Muse Code is Meta's, and has no mark of its own: it gets Meta's.
 * The marks are their owners' trademarks, used here only to say which agent is which.
 */

interface Logo {
  /** One color: fills with the text color */
  mono: boolean
  /** Crops to the mark, for one drawn to sit inside its own square (Codex, Kiro) */
  viewBox?: string
  /** The paths, given an id prefix unique to this copy for its gradients */
  draw(id: string): ReactNode
}

export const AGENT_LOGOS: Record<string, Logo> = {
  // Claude Code
  claude: {
    mono: false,
    draw: (_id) => (
      <>
        <path
          clipRule="evenodd"
          d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
          fill="#D97757"
          fillRule="evenodd"
        />
      </>
    ),
  },
  // Codex
  codex: {
    mono: false,
    viewBox: '2 2 20 20',
    draw: (id) => (
      <>
        <path
          d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
          fill={`url(#${id}-0)`}
        />
        <defs>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id={`${id}-0`}
            x1="12"
            x2="12"
            y1="3"
            y2="21"
          >
            <stop stopColor="#B1A7FF" />
            <stop offset=".5" stopColor="#7A9DFF" />
            <stop offset="1" stopColor="#3941FF" />
          </linearGradient>
        </defs>
      </>
    ),
  },
  // Grok
  grok: {
    mono: true,
    draw: (_id) => (
      <>
        <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
      </>
    ),
  },
  // Kiro
  kiro: {
    mono: false,
    viewBox: '3 3 18 18',
    draw: (_id) => (
      <>
        <path
          d="M7.97 16.376c-1.644 3.642 1.86 4.556 4.443 2.424.76 2.39 3.608.607 4.631-1.247 2.251-4.084 1.342-8.249 1.108-9.108-1.6-5.859-9.6-5.869-10.976.03-.323 1.033-.328 2.206-.507 3.423-.09.617-.16 1.009-.393 1.655-.139.373-.323.7-.62 1.257-.458.865-.264 2.53 2.101 1.665l.224-.1h-.01l-.001.001z"
          fill="#9046FF"
        />
        <path
          d="M12.722 10.985c-.656 0-.755-.785-.755-1.252 0-.423.074-.756.218-.97a.61.61 0 01.537-.283c.229 0 .428.095.567.289.159.218.243.55.243.964 0 .785-.303 1.252-.805 1.252h-.005zm2.703 0c-.656 0-.755-.785-.755-1.252 0-.423.074-.756.219-.97a.61.61 0 01.536-.283c.229 0 .428.095.567.289.159.218.243.55.243.964 0 .785-.303 1.252-.805 1.252h-.005z"
          fill="#000"
        />
      </>
    ),
  },
  // OpenCode
  opencode: {
    mono: true,
    draw: (_id) => (
      <>
        <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
      </>
    ),
  },
  // Pi
  pi: {
    mono: true,
    draw: (_id) => (
      <>
        <path clipRule="evenodd" d="M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z" />
        <path d="M17.5 12H23v11h-5.5V12z" />
      </>
    ),
  },
  // Muse Code: Meta's mark
  muse: {
    mono: false,
    draw: (id) => (
      <>
        <path
          d="M6.897 4h-.024l-.031 2.615h.022c1.715 0 3.046 1.357 5.94 6.246l.175.297.012.02 1.62-2.438-.012-.019a48.763 48.763 0 00-1.098-1.716 28.01 28.01 0 00-1.175-1.629C10.413 4.932 8.812 4 6.896 4z"
          fill={`url(#${id}-0)`}
        />
        <path
          d="M6.873 4C4.95 4.01 3.247 5.258 2.02 7.17a4.352 4.352 0 00-.01.017l2.254 1.231.011-.017c.718-1.083 1.61-1.774 2.568-1.785h.021L6.896 4h-.023z"
          fill={`url(#${id}-1)`}
        />
        <path
          d="M2.019 7.17l-.011.017C1.2 8.447.598 9.995.274 11.664l-.005.022 2.534.6.004-.022c.27-1.467.786-2.828 1.456-3.845l.011-.017L2.02 7.17z"
          fill={`url(#${id}-2)`}
        />
        <path
          d="M2.807 12.264l-2.533-.6-.005.022c-.177.918-.267 1.851-.269 2.786v.023l2.598.233v-.023a12.591 12.591 0 01.21-2.44z"
          fill={`url(#${id}-3)`}
        />
        <path
          d="M2.677 15.537a5.462 5.462 0 01-.079-.813v-.022L0 14.468v.024a8.89 8.89 0 00.146 1.652l2.535-.585a4.106 4.106 0 01-.004-.022z"
          fill={`url(#${id}-4)`}
        />
        <path
          d="M3.27 16.89c-.284-.31-.484-.756-.589-1.328l-.004-.021-2.535.585.004.021c.192 1.01.568 1.85 1.106 2.487l.014.017 2.018-1.745a2.106 2.106 0 01-.015-.016z"
          fill={`url(#${id}-5)`}
        />
        <path
          d="M10.78 9.654c-1.528 2.35-2.454 3.825-2.454 3.825-2.035 3.2-2.739 3.917-3.871 3.917a1.545 1.545 0 01-1.186-.508l-2.017 1.744.014.017C2.01 19.518 3.058 20 4.356 20c1.963 0 3.374-.928 5.884-5.33l1.766-3.13a41.283 41.283 0 00-1.227-1.886z"
          fill="#0082FB"
        />
        <path
          d="M13.502 5.946l-.016.016c-.4.43-.786.908-1.16 1.416.378.483.768 1.024 1.175 1.63.48-.743.928-1.345 1.367-1.807l.016-.016-1.382-1.24z"
          fill={`url(#${id}-6)`}
        />
        <path
          d="M20.918 5.713C19.853 4.633 18.583 4 17.225 4c-1.432 0-2.637.787-3.723 1.944l-.016.016 1.382 1.24.016-.017c.715-.747 1.408-1.12 2.176-1.12.826 0 1.6.39 2.27 1.075l.015.016 1.589-1.425-.016-.016z"
          fill="#0082FB"
        />
        <path
          d="M23.998 14.125c-.06-3.467-1.27-6.566-3.064-8.396l-.016-.016-1.588 1.424.015.016c1.35 1.392 2.277 3.98 2.361 6.971v.023h2.292v-.022z"
          fill={`url(#${id}-7)`}
        />
        <path
          d="M23.998 14.15v-.023h-2.292v.022c.004.14.006.282.006.424 0 .815-.121 1.474-.368 1.95l-.011.022 1.708 1.782.013-.02c.62-.96.946-2.293.946-3.91 0-.083 0-.165-.002-.247z"
          fill={`url(#${id}-8)`}
        />
        <path
          d="M21.344 16.52l-.011.02c-.214.402-.519.67-.917.787l.778 2.462a3.493 3.493 0 00.438-.182 3.558 3.558 0 001.366-1.218l.044-.065.012-.02-1.71-1.784z"
          fill={`url(#${id}-9)`}
        />
        <path
          d="M19.92 17.393c-.262 0-.492-.039-.718-.14l-.798 2.522c.449.153.927.222 1.46.222.492 0 .943-.073 1.352-.215l-.78-2.462c-.167.05-.341.075-.517.073z"
          fill={`url(#${id}-10)`}
        />
        <path
          d="M18.323 16.534l-.014-.017-1.836 1.914.016.017c.637.682 1.246 1.105 1.937 1.337l.797-2.52c-.291-.125-.573-.353-.9-.731z"
          fill={`url(#${id}-11)`}
        />
        <path
          d="M18.309 16.515c-.55-.642-1.232-1.712-2.303-3.44l-1.396-2.336-.011-.02-1.62 2.438.012.02.989 1.668c.959 1.61 1.74 2.774 2.493 3.585l.016.016 1.834-1.914a2.353 2.353 0 01-.014-.017z"
          fill={`url(#${id}-12)`}
        />
        <defs>
          <linearGradient id={`${id}-0`} x1="75.897%" x2="26.312%" y1="89.199%" y2="12.194%">
            <stop offset=".06%" stopColor="#0867DF" />
            <stop offset="45.39%" stopColor="#0668E1" />
            <stop offset="85.91%" stopColor="#0064E0" />
          </linearGradient>
          <linearGradient id={`${id}-1`} x1="21.67%" x2="97.068%" y1="75.874%" y2="23.985%">
            <stop offset="13.23%" stopColor="#0064DF" />
            <stop offset="99.88%" stopColor="#0064E0" />
          </linearGradient>
          <linearGradient id={`${id}-2`} x1="38.263%" x2="60.895%" y1="89.127%" y2="16.131%">
            <stop offset="1.47%" stopColor="#0072EC" />
            <stop offset="68.81%" stopColor="#0064DF" />
          </linearGradient>
          <linearGradient id={`${id}-3`} x1="47.032%" x2="52.15%" y1="90.19%" y2="15.745%">
            <stop offset="7.31%" stopColor="#007CF6" />
            <stop offset="99.43%" stopColor="#0072EC" />
          </linearGradient>
          <linearGradient id={`${id}-4`} x1="52.155%" x2="47.591%" y1="58.301%" y2="37.004%">
            <stop offset="7.31%" stopColor="#007FF9" />
            <stop offset="100%" stopColor="#007CF6" />
          </linearGradient>
          <linearGradient id={`${id}-5`} x1="37.689%" x2="61.961%" y1="12.502%" y2="63.624%">
            <stop offset="7.31%" stopColor="#007FF9" />
            <stop offset="100%" stopColor="#0082FB" />
          </linearGradient>
          <linearGradient id={`${id}-6`} x1="34.808%" x2="62.313%" y1="68.859%" y2="23.174%">
            <stop offset="27.99%" stopColor="#007FF8" />
            <stop offset="91.41%" stopColor="#0082FB" />
          </linearGradient>
          <linearGradient id={`${id}-7`} x1="43.762%" x2="57.602%" y1="6.235%" y2="98.514%">
            <stop offset="0%" stopColor="#0082FB" />
            <stop offset="99.95%" stopColor="#0081FA" />
          </linearGradient>
          <linearGradient id={`${id}-8`} x1="60.055%" x2="39.88%" y1="4.661%" y2="69.077%">
            <stop offset="6.19%" stopColor="#0081FA" />
            <stop offset="100%" stopColor="#0080F9" />
          </linearGradient>
          <linearGradient id={`${id}-9`} x1="30.282%" x2="61.081%" y1="59.32%" y2="33.244%">
            <stop offset="0%" stopColor="#027AF3" />
            <stop offset="100%" stopColor="#0080F9" />
          </linearGradient>
          <linearGradient id={`${id}-10`} x1="20.433%" x2="82.112%" y1="50.001%" y2="50.001%">
            <stop offset="0%" stopColor="#0377EF" />
            <stop offset="99.94%" stopColor="#0279F1" />
          </linearGradient>
          <linearGradient id={`${id}-11`} x1="40.303%" x2="72.394%" y1="35.298%" y2="57.811%">
            <stop offset=".19%" stopColor="#0471E9" />
            <stop offset="100%" stopColor="#0377EF" />
          </linearGradient>
          <linearGradient id={`${id}-12`} x1="32.254%" x2="68.003%" y1="19.719%" y2="84.908%">
            <stop offset="27.65%" stopColor="#0867DF" />
            <stop offset="100%" stopColor="#0471E9" />
          </linearGradient>
        </defs>
      </>
    ),
  },
}

/** An agent's mark at the size of its box (`className` sets it), or null if it has none. */
export function AgentLogo({ agentId, className }: { agentId: string; className?: string }) {
  const id = useId()
  const logo = Object.hasOwn(AGENT_LOGOS, agentId) ? AGENT_LOGOS[agentId] : null
  if (!logo) return null
  return (
    <svg
      viewBox={logo.viewBox ?? '0 0 24 24'}
      aria-hidden="true"
      className={className}
      fill={logo.mono ? 'currentColor' : undefined}
      fillRule={logo.mono ? 'evenodd' : undefined}
    >
      {logo.draw(id)}
    </svg>
  )
}
