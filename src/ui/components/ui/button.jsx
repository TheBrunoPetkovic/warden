import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva("ui-button", {
  variants: {
    variant: { default: "", ghost: "", destructive: "" },
    size: { default: "", icon: "" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props}/>;
}

export { Button, buttonVariants };
