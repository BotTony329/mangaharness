/**
 * DataTransfer type for dragging an expression chip onto a puppet's face.
 *
 * Its own module so the inspector (which starts the drag) and the canvas
 * (which receives it) share one constant without importing each other.
 */
export const EXPRESSION_DRAG_TYPE = "application/x-puppet-expression";
