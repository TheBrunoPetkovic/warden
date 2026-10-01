import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../lib/utils.js";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({ className, sideOffset = 6, ...props }) {
  return <TooltipPrimitive.Portal><TooltipPrimitive.Content className={cn("ui-tooltip", className)} sideOffset={sideOffset} {...props}/></TooltipPrimitive.Portal>;
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
