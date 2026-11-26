type PreferenceReader = {loadPreference(key: string): string | null};

/** Display fallbacks retain the read error; editors must read saved documents strictly. */
export function readOptionalPreference(
  reader: PreferenceReader,
  key: string,
  label: string
): {value: string | null; error?: string} {
  try {
    return {value: reader.loadPreference(key)};
  } catch (error) {
    return {
      value: null,
      error: `Saved ${label} could not be read. Existing data is unchanged. ${String(error)}`
    };
  }
}
