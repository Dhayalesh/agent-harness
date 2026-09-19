import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Custom type sizes must be recognised as sizes, otherwise text colours replace them.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "tiny", "small", "medium", "large", "title", "display"] }],
    },
  },
});

/**
 * The shadcn/ui class composer.
 *
 * `clsx` flattens conditionals and arrays; `tailwind-merge` then resolves
 * conflicts so a caller's `className` always wins over a component's default.
 * That last part is what makes `<Button className="h-6">` behave as expected
 * instead of depending on stylesheet order.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
