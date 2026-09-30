// Map registry. Pick with ?map=<id> (the menu's map selector reloads with it).
import street from './street.js';
import cloister from './cloister.js';
import city from './city.js';

export const MAPS = [street, cloister, city];

export function pickMap(id) {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
