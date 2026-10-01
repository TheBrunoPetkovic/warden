import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils.js";

function Checkbox({ className, ...props }) {
  return <CheckboxPrimitive.Root className={cn("ui-checkbox", className)} {...props}>
    <CheckboxPrimitive.Indicator><Check aria-hidden="true"/></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
}

export { Checkbox };
