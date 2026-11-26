import {parseRecipe, serializeRecipe} from '../../core/automation.ts';
import type {Recipe} from '../../core/automation.ts';
import type {AppPort} from '../session/types.ts';

type RecipeStorage = Pick<AppPort, 'loadPreference' | 'savePreference'>;
export type SavedRecipes = {recipes: Recipe[]; error?: string};
const preference = 'automation.recipes.v1';
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const blocked = (reason: string) => `${reason} Original saved data is unchanged. Saving protocols is blocked until the saved data is repaired. You can open valid protocols and export drafts as JSON.`;

export function readSavedRecipes(port: Pick<AppPort, 'loadPreference'>): SavedRecipes {
  try {
    const raw = port.loadPreference(preference);
    if (raw === null) return {recipes: []};
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('Expected a saved protocol list.');
    const recipes: Recipe[] = [];
    const errors: string[] = [];
    data.forEach((value, index) => {
      try {
        recipes.push(parseRecipe(JSON.stringify(value)));
      } catch (error) {
        errors.push(`entry ${index + 1}: ${detail(error)}`);
      }
    });
    return errors.length
      ? {recipes, error: blocked(`Could not read ${errors.length} saved protocol ${errors.length === 1 ? 'entry' : 'entries'} (${errors.join('; ')}).`)}
      : {recipes};
  } catch (error) {
    return {recipes: [], error: blocked(`Could not read saved protocols: ${detail(error)}`)};
  }
}

export async function saveSavedRecipe(port: RecipeStorage, recipe: Recipe): Promise<Recipe[]> {
  // Validation uses the current stored collection so an old screen cannot
  // replace entries that have become unreadable since it opened.
  const current = readSavedRecipes(port);
  if (current.error) throw new Error(current.error);
  const valid = parseRecipe(serializeRecipe(recipe));
  const next = [...current.recipes.filter(item => item.name !== valid.name), valid];
  await port.savePreference(preference, JSON.stringify(next));
  return next;
}
