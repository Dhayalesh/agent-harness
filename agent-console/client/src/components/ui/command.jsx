import { Command as CommandPrimitive } from "cmdk";
import { Search, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const Command = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex min-h-0 w-full flex-col overflow-hidden bg-popover text-popover-foreground",
      className,
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

const CommandDialog = ({
  children,
  className,
  title = "Command palette",
  description = "Search for a command to run.",
  ...props
}) => (
  <Dialog {...props}>
    <DialogContent
      showCloseButton={false}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        event.target.querySelector("[cmdk-input]")?.focus();
      }}
      className={cn("top-[8dvh] flex max-h-[84dvh] w-[calc(100%-2rem)] max-w-[640px] translate-y-0 flex-col overflow-hidden rounded-2xl p-0", className)}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-divider bg-content2/50 px-5 py-4">
        <div className="min-w-0">
          <DialogTitle className="text-large font-semibold leading-6">{title}</DialogTitle>
          <DialogDescription className="mt-1 text-tiny leading-5 text-default-500">{description}</DialogDescription>
        </div>
        <DialogClose aria-label="Close search" className="grid size-8 shrink-0 place-items-center rounded-lg text-default-500 transition-colors hover:bg-primary/[0.06] hover:text-foreground">
          <X className="size-4" />
        </DialogClose>
      </div>
      <Command
        // cmdk renders the group heading as a sibling of its items, so the
        // spacing has to be set here rather than on the group.
        className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-tiny [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-default-500"
      >
        {children}
      </Command>
    </DialogContent>
  </Dialog>
);

const CommandInput = React.forwardRef(({ className, ...props }, ref) => (
  <div
    className="mx-4 mb-2 mt-4 flex shrink-0 items-center gap-3 rounded-xl border border-divider bg-content2/50 px-3.5 transition-colors focus-within:border-primary/40 focus-within:bg-content1 focus-within:ring-2 focus-within:ring-primary/10"
    cmdk-input-wrapper=""
  >
    <Search className="size-4 shrink-0 text-default-400" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-12 min-w-0 w-full bg-transparent text-medium text-foreground outline-none placeholder:text-default-400 focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn(
      "min-h-0 max-h-[min(420px,50dvh)] overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-3",
      className,
    )}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="px-5 py-12 text-center text-small text-default-500"
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn("overflow-hidden p-1 text-foreground", className)}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn("h-px bg-divider", className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

/** Rounded highlights follow pointer and keyboard selection. */
const CommandItem = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "group relative flex min-h-12 cursor-pointer select-none items-center gap-3 rounded-lg px-3 py-2.5 text-small outline-none transition-colors duration-150",
      "data-[selected=true]:bg-primary/[0.06] data-[selected=true]:text-primary data-[selected=true]:ring-1 data-[selected=true]:ring-inset data-[selected=true]:ring-primary/10",
      "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      "[&_svg]:size-4 [&_svg]:shrink-0",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandShortcut = ({ className, ...props }) => (
  <span
    className={cn(
      "ml-auto font-mono text-micro tracking-label text-default-400",
      className,
    )}
    {...props}
  />
);
CommandShortcut.displayName = "CommandShortcut";

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
