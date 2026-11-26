/** A bounded catalog page; filtering cannot leave a hidden item selected. */
export function libraryPage<T extends {key:string}>(all:T[],requestedPage:number,selectedKey?:string,pageSize=6){
 const size=Math.max(1,Math.trunc(pageSize)||6);
 const pages=Math.ceil(all.length/size);
 const page=Math.max(0,Math.min(Math.max(0,pages-1),Math.trunc(requestedPage)||0));
 const items=all.slice(page*size,page*size+size);
 return {items,page,pages,selected:items.find(item=>item.key===selectedKey)??items[0]};
}
