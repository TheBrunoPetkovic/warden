import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "../../lib/utils.js";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuSeparator = DropdownMenuPrimitive.Separator;

function DropdownMenuContent({ className, sideOffset = 6, ...props }) {
  return <DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.Content className={cn("workspace-menu", className)} sideOffset={sideOffset} {...props}/></DropdownMenuPrimitive.Portal>;
}

function DropdownMenuItem({ className, ...props }) {
  return <DropdownMenuPrimitive.Item className={cn("workspace-menu-item", className)} {...props}/>;
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger };
