import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

import { AlertDialog } from "./ui/primitives.js";

export interface AtlasConfirmationOptions {
  readonly confirmLabel?: string;
  readonly description: string;
  readonly title: string;
  readonly tone?: "danger" | "default";
}

type RequestConfirmation = (
  options: AtlasConfirmationOptions,
) => Promise<boolean>;

interface PendingConfirmation extends AtlasConfirmationOptions {
  readonly resolve: (confirmed: boolean) => void;
}

const AtlasConfirmationContext = createContext<RequestConfirmation>(
  async () => false,
);

/** Hosts the single modal confirmation surface shared by Atlas. */
export function AtlasConfirmationProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [pending, setPending] = useState<PendingConfirmation>();
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<PendingConfirmation | undefined>(undefined);
  const requestConfirmation = useCallback<RequestConfirmation>((options) => {
    // Resolve a superseded request defensively instead of leaving its promise open.
    pendingRef.current?.resolve(false);

    return new Promise<boolean>((resolve) => {
      const request = { ...options, resolve };

      pendingRef.current = request;
      setPending(request);
      setOpen(true);
    });
  }, []);
  const settle = useCallback((confirmed: boolean) => {
    const request = pendingRef.current;

    if (request === undefined) {
      return;
    }

    pendingRef.current = undefined;
    // Retain the settled request while Base UI animates the popup out.
    setOpen(false);
    request.resolve(confirmed);
  }, []);

  return (
    <AtlasConfirmationContext.Provider value={requestConfirmation}>
      {children}
      <AlertDialog.Root
        onOpenChange={(open) => {
          if (!open) {
            settle(false);
          }
        }}
        onOpenChangeComplete={(open) => {
          // Clear content only once the closing transition can no longer display it.
          if (!open && pendingRef.current === undefined) {
            setPending(undefined);
          }
        }}
        open={open}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="dialog-backdrop" />
          <AlertDialog.Viewport className="dialog-viewport">
            <AlertDialog.Popup className="confirmation-panel">
              <AlertDialog.Title>{pending?.title}</AlertDialog.Title>
              <AlertDialog.Description>
                {pending?.description}
              </AlertDialog.Description>
              <div className="confirmation-actions">
                <AlertDialog.Close className="button">
                  Cancel
                </AlertDialog.Close>
                <button
                  className={`button${pending?.tone === "danger" ? " danger" : " primary"}`}
                  onClick={() => settle(true)}
                  type="button"
                >
                  {pending?.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </AtlasConfirmationContext.Provider>
  );
}

/** Requests a modal confirmation from anywhere inside Atlas. */
export function useAtlasConfirmation(): RequestConfirmation {
  return useContext(AtlasConfirmationContext);
}
