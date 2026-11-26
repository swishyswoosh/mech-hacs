import {parseRecipe,serializeRecipe} from './automation.ts';
import type {Recipe} from './automation.ts';
/** Review is detached from both the editor draft and any running recipe. */
export interface RecipeFileReview {recipe:Recipe;text:string;steps:number}
export function reviewRecipeFile(text:string):RecipeFileReview{
 const recipe=parseRecipe(text);return {recipe,text:serializeRecipe(recipe),steps:recipe.steps.length};
}
export async function chooseRecipeFile(read:()=>Promise<string>):Promise<RecipeFileReview>{return reviewRecipeFile(await read());}
/** Invoke only from the explicit Save file action after presenting the review. */
export async function saveReviewedRecipeFile(review:RecipeFileReview,write:(name:string,text:string)=>Promise<void>):Promise<void>{
 const validated=reviewRecipeFile(review.text);await write('r2-recipe.json',validated.text);
}
