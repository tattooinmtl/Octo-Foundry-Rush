/**
 * Hand-drawn SVG icons for the side panel. Each one is shaded with gradients
 * so it reads as a small 3D object. Ids are made unique per call so many
 * copies can live on the page.
 */

let uid = 0;

function svg(body: (id: (n: string) => string) => string): string {
  const k = `i${++uid}`;
  const id = (n: string) => `${k}${n}`;
  return `<svg viewBox="0 0 48 48" class="ico" aria-hidden="true">${body(id)}</svg>`;
}

/** Metal radial "puck" behind every icon. */
const puck = (id: (n: string) => string, glow: string) => `
  <defs>
    <radialGradient id="${id('pk')}" cx="50%" cy="35%" r="70%">
      <stop offset="0" stop-color="#5a6673"/><stop offset=".6" stop-color="#262d35"/><stop offset="1" stop-color="#0c0f12"/>
    </radialGradient>
    <radialGradient id="${id('gl')}" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${glow}" stop-opacity=".55"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="24" cy="24" r="22" fill="url(#${id('pk')})" stroke="#000" stroke-opacity=".6"/>
  <circle cx="24" cy="24" r="21" fill="none" stroke="#fff" stroke-opacity=".12"/>
  <circle cx="24" cy="26" r="17" fill="url(#${id('gl')})"/>`;

const metal = (id: (n: string) => string, n: string, a: string, b: string, c: string) =>
  `<linearGradient id="${id(n)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".5" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`;

export const ICONS: Record<string, () => string> = {
  cannon: () =>
    svg((id) => `${puck(id, '#ff8a3d')}
      <defs>${metal(id, 'm', '#c9d2dc', '#6c7783', '#2a3037')}${metal(id, 'b', '#ffb37a', '#ff8a3d', '#8a3c0c')}</defs>
      <rect x="12" y="30" width="24" height="8" rx="3" fill="url(#${id('m')})" stroke="#111"/>
      <g transform="rotate(-32 24 30)">
        <rect x="21" y="9" width="10" height="23" rx="3" fill="url(#${id('m')})" stroke="#111"/>
        <rect x="20" y="8" width="12" height="4" rx="1.5" fill="url(#${id('b')})" stroke="#111"/>
      </g>
      <circle cx="24" cy="31" r="5.5" fill="url(#${id('b')})" stroke="#111"/>
      <circle cx="22.5" cy="29.5" r="1.6" fill="#fff" opacity=".7"/>`),

  tesla: () =>
    svg((id) => `${puck(id, '#59d8ff')}
      <defs>${metal(id, 'm', '#e6c48a', '#b07a2e', '#5a3a10')}</defs>
      <rect x="16" y="34" width="16" height="5" rx="2" fill="#39424c" stroke="#111"/>
      ${[0, 1, 2, 3, 4].map((i) => `<ellipse cx="24" cy="${31 - i * 4}" rx="${7 - i * 0.5}" ry="2.2" fill="url(#${id('m')})" stroke="#2a1a05" stroke-width=".8"/>`).join('')}
      <circle cx="24" cy="11" r="5" fill="#bfefff" stroke="#59d8ff" stroke-width="1.5"/>
      <path d="M28 10 L35 6 L32 12 L39 11" fill="none" stroke="#9ff0ff" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M20 10 L13 7 L16 13 L9 13" fill="none" stroke="#9ff0ff" stroke-width="1.6" stroke-linejoin="round"/>`),

  frost: () =>
    svg((id) => `${puck(id, '#9ceaff')}
      <defs><linearGradient id="${id('c')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#5cc8ff"/></linearGradient></defs>
      ${[0, 60, 120].map((r) => `<g transform="rotate(${r} 24 24)"><rect x="22.6" y="8" width="2.8" height="32" rx="1.4" fill="url(#${id('c')})"/>
        <path d="M24 13 l-4 -3 M24 13 l4 -3 M24 35 l-4 3 M24 35 l4 3" stroke="#dff6ff" stroke-width="2" stroke-linecap="round"/></g>`).join('')}
      <circle cx="24" cy="24" r="4" fill="#fff" stroke="#5cc8ff"/>`),

  bio: () =>
    svg((id) => `${puck(id, '#7dff6a')}
      <defs><radialGradient id="${id('s')}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#eaffd8"/><stop offset=".5" stop-color="#7dff6a"/><stop offset="1" stop-color="#1c6a12"/></radialGradient></defs>
      <path d="M24 40 C 22 32, 26 28, 24 22" stroke="#3a7a2a" stroke-width="3" fill="none"/>
      <circle cx="24" cy="19" r="8" fill="url(#${id('s')})" stroke="#103a0a"/>
      <circle cx="15" cy="27" r="5" fill="url(#${id('s')})" stroke="#103a0a"/>
      <circle cx="33" cy="28" r="5.5" fill="url(#${id('s')})" stroke="#103a0a"/>
      <circle cx="21" cy="16" r="1.5" fill="#fff" opacity=".8"/>`),

  flame: () =>
    svg((id) => `${puck(id, '#ff5a2a')}
      <defs><linearGradient id="${id('f')}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff2a00"/><stop offset=".55" stop-color="#ff8a1a"/><stop offset="1" stop-color="#ffe680"/></linearGradient>
      <linearGradient id="${id('f2')}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffb040"/><stop offset="1" stop-color="#fffbe0"/></linearGradient></defs>
      <rect x="15" y="34" width="18" height="6" rx="2" fill="#39424c" stroke="#111"/>
      <path d="M24 6 C 30 14, 36 18, 33 28 C 31 34, 17 34, 15 28 C 13 21, 19 18, 20 12 C 22 16, 23 17, 24 6 Z" fill="url(#${id('f')})" stroke="#6a1400"/>
      <path d="M24 16 C 27 21, 30 24, 28 29 C 27 32, 21 32, 20 29 C 19 25, 23 23, 24 16 Z" fill="url(#${id('f2')})"/>`),

  multi: () =>
    svg((id) => `${puck(id, '#ffd23d')}
      <defs><radialGradient id="${id('p')}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff6c8"/><stop offset=".5" stop-color="#ffd23d"/><stop offset="1" stop-color="#7a5a00"/></radialGradient>
      ${metal(id, 'm', '#c9d2dc', '#6c7783', '#2a3037')}</defs>
      <rect x="10" y="29" width="16" height="9" rx="3" fill="url(#${id('m')})" stroke="#111"/>
      <rect x="22" y="31" width="8" height="5" rx="1.5" fill="url(#${id('m')})" stroke="#111"/>
      <circle cx="36" cy="16" r="4" fill="url(#${id('p')})" stroke="#4a3500"/>
      <circle cx="38" cy="26" r="3.5" fill="url(#${id('p')})" stroke="#4a3500"/>
      <circle cx="30" cy="10" r="3" fill="url(#${id('p')})" stroke="#4a3500"/>
      <path d="M31 30 L35 19 M32 32 L37 27 M30 30 L30 13" stroke="#ffd23d" stroke-opacity=".5" stroke-dasharray="2 2"/>`),

  sniper: () =>
    svg((id) => `${puck(id, '#ff4d6d')}
      <circle cx="24" cy="24" r="12" fill="none" stroke="#ff4d6d" stroke-width="2.4"/>
      <circle cx="24" cy="24" r="12" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width=".8"/>
      <path d="M24 6 V16 M24 32 V42 M6 24 H16 M32 24 H42" stroke="#ffd0d8" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="24" cy="24" r="3" fill="#ff4d6d"/><circle cx="23" cy="23" r="1" fill="#fff"/>`),

  forge: () =>
    svg((id) => `${puck(id, '#f5c518')}
      <defs>${metal(id, 'a', '#d6dde5', '#7a8590', '#2a3037')}</defs>
      <path d="M8 18 H36 C 36 24, 32 26, 28 26 V30 H32 V35 H14 V30 H18 V26 C 13 26, 9 23, 8 18 Z" fill="url(#${id('a')})" stroke="#111"/>
      <path d="M36 18 H41 L36 22 Z" fill="url(#${id('a')})" stroke="#111"/>
      <path d="M27 6 L22 15 H27 L23 24 L33 12 H27 L31 6 Z" fill="#f5c518" stroke="#5a4500" stroke-width="1"/>`),

  dynamite: () =>
    svg((id) => `${puck(id, '#ff7a2a')}
      <defs><linearGradient id="${id('d')}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6a0e08"/><stop offset=".35" stop-color="#e2382a"/><stop offset=".6" stop-color="#ff7a64"/><stop offset="1" stop-color="#7a120a"/></linearGradient>
      <radialGradient id="${id('sp')}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="#ffe066"/><stop offset="1" stop-color="#ff6a00" stop-opacity="0"/></radialGradient></defs>
      <g transform="rotate(-12 24 28)">
        <rect x="11" y="18" width="8" height="22" rx="3" fill="url(#${id('d')})" stroke="#2a0402"/>
        <rect x="20" y="16" width="8" height="24" rx="3" fill="url(#${id('d')})" stroke="#2a0402"/>
        <rect x="29" y="18" width="8" height="22" rx="3" fill="url(#${id('d')})" stroke="#2a0402"/>
        <rect x="10" y="26" width="28" height="5" fill="#2a2f35" stroke="#111"/>
        <text x="24" y="30.4" font-size="4" text-anchor="middle" fill="#f5c518" font-family="Arial" font-weight="700">TNT</text>
        <path d="M24 16 C 24 11, 29 11, 30 7" stroke="#d8c08a" stroke-width="1.6" fill="none"/>
      </g>
      <circle cx="32" cy="7.5" r="5.5" fill="url(#${id('sp')})"/>
      <path d="M32 2 V5 M32 10 V13 M26.5 7.5 H29.5 M34.5 7.5 H37.5" stroke="#fff6b0" stroke-width="1.1"/>`),

  laser: () =>
    svg((id) => `${puck(id, '#ff2a6a')}
      <defs><linearGradient id="${id('bm')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4dff8a"/><stop offset=".45" stop-color="#b04dff"/><stop offset="1" stop-color="#ff2a4a"/></linearGradient>
      ${metal(id, 's', '#e6edf5', '#8794a2', '#2a3037')}</defs>
      <rect x="9" y="7" width="8" height="5" fill="#2a5aa8" stroke="#0a1a3a"/>
      <rect x="31" y="7" width="8" height="5" fill="#2a5aa8" stroke="#0a1a3a"/>
      <rect x="17" y="5" width="14" height="9" rx="2" fill="url(#${id('s')})" stroke="#111"/>
      <path d="M21 14 L19 40 H29 L27 14 Z" fill="url(#${id('bm')})" opacity=".9"/>
      <path d="M23.2 14 L22.6 40 H25.4 L24.8 14 Z" fill="#fff" opacity=".9"/>
      <ellipse cx="24" cy="40" rx="10" ry="3" fill="#ff2a6a" opacity=".55"/>
      <ellipse cx="24" cy="40" rx="5" ry="1.5" fill="#fff"/>`),

  freeze: () =>
    svg((id) => `${puck(id, '#7fdcff')}
      <defs><radialGradient id="${id('b')}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#9fe8ff"/><stop offset="1" stop-color="#1a5aa8"/></radialGradient></defs>
      <circle cx="24" cy="27" r="12" fill="url(#${id('b')})" stroke="#0a2a5a"/>
      <rect x="21" y="11" width="6" height="5" rx="1" fill="#39424c" stroke="#111"/>
      ${[0, 60, 120].map((r) => `<g transform="rotate(${r} 24 27)"><path d="M24 19 V35 M24 21 l-2.5 -2 M24 21 l2.5 -2 M24 33 l-2.5 2 M24 33 l2.5 2" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/></g>`).join('')}
      <ellipse cx="20" cy="22" rx="3" ry="2" fill="#fff" opacity=".7"/>`),

  hellfire: () =>
    svg((id) => `${puck(id, '#ff5a1a')}
      <defs><radialGradient id="${id('m')}" cx="40%" cy="40%" r="65%"><stop offset="0" stop-color="#fff2a0"/><stop offset=".4" stop-color="#ff8a1a"/><stop offset="1" stop-color="#6a0a00"/></radialGradient>
      <linearGradient id="${id('t')}" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff6a00"/><stop offset="1" stop-color="#ff6a00" stop-opacity="0"/></linearGradient></defs>
      <path d="M30 30 L6 4 L12 2 L36 26 Z" fill="url(#${id('t')})"/>
      <path d="M28 33 L10 10 L15 8 L34 29 Z" fill="url(#${id('t')})" opacity=".6"/>
      <circle cx="31" cy="31" r="9" fill="url(#${id('m')})" stroke="#3a0600"/>
      <path d="M14 42 C 18 36, 22 40, 24 35 C 26 40, 30 36, 34 42 Z" fill="#ff3a0a" opacity=".85"/>`),

  speed: () =>
    svg((id) => `${puck(id, '#f5c518')}<path d="M13 15 L24 24 L13 33 Z M24 15 L35 24 L24 33 Z" fill="#f5c518" stroke="#5a4500"/>`),
  sound: () =>
    svg((id) => `${puck(id, '#aab6c4')}<path d="M12 20 H18 L26 13 V35 L18 28 H12 Z" fill="#dfe6ee" stroke="#111"/><path d="M30 18 C 34 21, 34 27, 30 30 M33 14 C 39 19, 39 29, 33 34" stroke="#dfe6ee" stroke-width="2.2" fill="none" stroke-linecap="round"/>`),
  mute: () =>
    svg((id) => `${puck(id, '#ff4a3d')}<path d="M12 20 H18 L26 13 V35 L18 28 H12 Z" fill="#dfe6ee" stroke="#111"/><path d="M30 19 L38 29 M38 19 L30 29" stroke="#ff4a3d" stroke-width="2.6" stroke-linecap="round"/>`),
  pause: () =>
    svg((id) => `${puck(id, '#aab6c4')}<rect x="15" y="13" width="6" height="22" rx="1.5" fill="#dfe6ee" stroke="#111"/><rect x="27" y="13" width="6" height="22" rx="1.5" fill="#dfe6ee" stroke="#111"/>`),
  settings: () =>
    svg((id) => `${puck(id, '#aab6c4')}<g transform="translate(24 24)">${[0, 45, 90, 135].map((r) => `<rect x="-2.6" y="-14" width="5.2" height="28" rx="1.2" transform="rotate(${r})" fill="#cfd8e2" stroke="#111" stroke-width=".7"/>`).join('')}<circle r="9" fill="#cfd8e2" stroke="#111"/><circle r="4" fill="#262d35"/></g>`),
};

export function icon(name: string): string {
  return (ICONS[name] ?? ICONS.forge)();
}
