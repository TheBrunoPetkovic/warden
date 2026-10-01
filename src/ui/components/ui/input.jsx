import { cn } from "../../lib/utils.js";

function Input({ className, ...props }) {
  return <input className={cn("ui-input", className)} {...props}/>;
}

export { Input };
