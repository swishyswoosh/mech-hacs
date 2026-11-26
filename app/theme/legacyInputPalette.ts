/** A deliberate opaque input surface works in either card theme. RN Web uses
 * caretColor; Android uses the native cursorColor prop. Editing stays native. */
export const inputPalette={background:'#ffffff',text:'#182235',caret:'#182235',placeholder:'#46566b',selection:'#bfd4ff'} as const;
export const inputSurface={backgroundColor:inputPalette.background,color:inputPalette.text,caretColor:inputPalette.caret} as const;
