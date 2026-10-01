import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../../lib/utils.js";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogTitle = DialogPrimitive.Title;

function DialogOverlay({ className, ...props }) {
  return <DialogPrimitive.Overlay className={cn(className)} {...props}/>;
}

function DialogContent({ className, ...props }) {
  return <DialogPrimitive.Portal><DialogPrimitive.Content className={cn(className)} {...props}/></DialogPrimitive.Portal>;
}

export { Dialog, DialogClose, DialogContent, DialogOverlay, DialogTitle, DialogTrigger };
