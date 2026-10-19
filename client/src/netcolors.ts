// Farben der Netzkarte – eigenes Modul ohne Leaflet, damit auch Tests (ohne Browser) sie benutzen können
export const NET_COLOR = {
  S: '#1d6fc4',
  // Bim in ihrem dunklen Rot – dünner und dunkler als die U1, damit man sie nicht verwechselt
  T: '#a8475a',
  /** Bim, wenn sie hervorgehoben ist */
  Tfocus: '#9e1b32',
  BB: '#2b4c9b',
  B: '#5f6f86',
  N: '#22304f',
  band: { ring: '#e39a2d', guertel: '#d9487a', vorort: '#2f9e63' },
};
