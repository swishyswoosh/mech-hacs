import type {PreferenceStore} from '../app/session/types.ts';

export function browserPreferenceStorage(
  storage: Pick<Storage, 'getItem' | 'setItem'>
): PreferenceStore {
  return {
    load: key => storage.getItem(`r2.${key}`),
    save: (key, value) => {
      const storageKey = `r2.${key}`;
      // A failed read cannot establish that it is safe to replace saved bytes.
      storage.getItem(storageKey);
      storage.setItem(storageKey, value);
    }
  };
}
