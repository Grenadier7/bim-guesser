// Einstieg: erst den Account-Stand (Lernstand, Einstellungen …) in den Browser holen, dann die App laden –
// die Module lesen ihren Stand beim Import aus dem localStorage.
import { preload } from './account.ts';
import { applyTheme } from './theme.ts';

// Hell/Dunkel sofort setzen – sonst blitzt die Seite beim Laden hell auf
applyTheme();

void preload().finally(() => import('./main.ts'));
