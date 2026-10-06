import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
} from "react";

import type {
  AtlasClientEffect,
  AtlasManifest,
  AtlasNotificationPosition,
  AtlasOperationResponse,
  AtlasRecordActionFeedback,
} from "../../contract.js";
import { Toast } from "./ui/primitives.js";
import {
  getAtlasBasePath,
  getAtlasTargetPath,
} from "./runtime.js";

type NotificationEffect = Extract<
  AtlasClientEffect,
  { type: "notification" }
>;

interface AtlasToastData {
  readonly link?: NotificationEffect["link"];
}

export interface AtlasActionFeedbackOptions {
  readonly label: string;
  readonly feedback?: AtlasRecordActionFeedback;
}

interface AtlasEffectContextValue {
  publish(effects: readonly AtlasClientEffect[]): void;
  trackAction<Response extends AtlasOperationResponse>(
    promise: Promise<Response>,
    options: AtlasActionFeedbackOptions,
  ): Promise<Response>;
}

const AtlasEffectContext = createContext<AtlasEffectContextValue>({
  publish: () => undefined,
  trackAction: (promise) => promise,
});

/** Keeps notifications mounted across route changes caused by effects. */
export function AtlasEffectProvider({
  children,
  manifest,
}: {
  readonly children: ReactNode;
  readonly manifest: AtlasManifest;
}) {
  return (
    <Toast.Provider limit={5} timeout={6_000}>
      <AtlasEffects manifest={manifest}>{children}</AtlasEffects>
    </Toast.Provider>
  );
}

/** Bridges typed atlas effects to Base UI's managed toast queue. */
function AtlasEffects({
  children,
  manifest,
}: {
  readonly children: ReactNode;
  readonly manifest: AtlasManifest;
}) {
  const toastManager = Toast.useToastManager<AtlasToastData>();
  const publish = useCallback(
    (effects: readonly AtlasClientEffect[]) => {
      for (const effect of effects) {
        if (effect.type !== "notification") {
          continue;
        }

        toastManager.add({
          description: effect.message,
          priority: effect.level === "error" ? "high" : "low",
          type: effect.level,
          ...(effect.link === undefined ? {} : { data: { link: effect.link } }),
        });
      }
    },
    [toastManager],
  );
  const trackAction = useCallback(
    <Response extends AtlasOperationResponse>(
      promise: Promise<Response>,
      options: AtlasActionFeedbackOptions,
    ) => {
      const messages = getAtlasActionFeedbackMessages(options);

      return toastManager.promise(promise, {
        loading: { description: messages.loading },
        success: (response) => {
          const resolved = resolveAtlasActionSuccess(
            response.effects,
            messages.success,
          );

          // The selected success notification becomes the promise toast. Any
          // additional notifications still enter the managed queue normally.
          publish(resolved.remainingEffects);

          return {
            description: resolved.message,
            ...(resolved.link === undefined
              ? {}
              : { data: { link: resolved.link } }),
          };
        },
        error: {
          description: messages.error,
          priority: "high",
        },
      });
    },
    [publish, toastManager],
  );

  return (
    <AtlasEffectContext.Provider value={{ publish, trackAction }}>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          className={`notification-stack ${manifest.notifications.position}`}
        >
          {toastManager.toasts.map((toast) => (
            <Toast.Root
              className={`notification ${toast.type ?? "info"}`}
              key={toast.id}
              swipeDirection={getAtlasNotificationSwipeDirections(
                manifest.notifications.position,
              )}
              toast={toast}
            >
              <Toast.Content className="notification-content">
                <Toast.Description>{toast.description}</Toast.Description>
                {toast.data?.link === undefined ? null : (
                  <a href={`${getAtlasBasePath(manifest.basePath)}${
                    getAtlasTargetPath(manifest, toast.data.link.target)
                  }`}>
                    {toast.data.link.label}
                  </a>
                )}
              </Toast.Content>
              <Toast.Close
                aria-label="Dismiss notification"
              >
                ×
              </Toast.Close>
            </Toast.Root>
          ))}
        </Toast.Viewport>
      </Toast.Portal>
    </AtlasEffectContext.Provider>
  );
}

/** Publishes client effects from one successful operation. */
export function useAtlasEffects() {
  return useContext(AtlasEffectContext).publish;
}

/** Tracks one record Action with a persistent Base UI promise toast. */
export function useAtlasActionFeedback() {
  return useContext(AtlasEffectContext).trackAction;
}

/** Resolves label-safe defaults without assuming the label is a verb phrase. */
export function getAtlasActionFeedbackMessages({
  feedback,
  label,
}: AtlasActionFeedbackOptions): Required<AtlasRecordActionFeedback> {
  return {
    loading: feedback?.loading ?? `Running “${label}”…`,
    success: feedback?.success ?? `“${label}” completed.`,
    error: feedback?.error ?? `“${label}” failed.`,
  };
}

/** Lets the first successful notification replace the generic success toast. */
export function resolveAtlasActionSuccess(
  effects: readonly AtlasClientEffect[],
  fallbackMessage: string,
): {
  readonly message: string;
  readonly link?: NotificationEffect["link"];
  readonly remainingEffects: readonly AtlasClientEffect[];
} {
  const notificationIndex = effects.findIndex(
    (effect) => effect.type === "notification" && effect.level === "success",
  );

  if (notificationIndex === -1) {
    return { message: fallbackMessage, remainingEffects: effects };
  }

  const notification = effects[notificationIndex] as NotificationEffect;

  return {
    message: notification.message,
    ...(notification.link === undefined ? {} : { link: notification.link }),
    remainingEffects: effects.filter((_, index) => index !== notificationIndex),
  };
}

/** Dismisses each stack toward the two viewport edges nearest to it. */
export function getAtlasNotificationSwipeDirections(
  position: AtlasNotificationPosition,
): ("up" | "down" | "left" | "right")[] {
  const vertical = position.startsWith("top") ? "up" : "down";
  const horizontal = position.endsWith("left") ? "left" : "right";

  return [vertical, horizontal];
}
