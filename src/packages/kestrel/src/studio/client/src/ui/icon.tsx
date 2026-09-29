import {
  faArrowRotateRight,
  faArrowRightFromBracket,
  faBoxOpen,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faCircleCheck,
  faCircleNotch,
  faClockRotateLeft,
  faCodeBranch,
  faEye,
  faEllipsisVertical,
  faFloppyDisk,
  faFolderTree,
  faGear,
  faHouse,
  faKey,
  faLock,
  faPause,
  faPen,
  faPlay,
  faPlus,
  faRotateRight,
  faTable,
  faTrash,
  faTriangleExclamation,
  faUpRightFromSquare,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import {
  fontAwesomeIcon,
  type SvgIconDefinition,
} from "../../../icon_definition.js";

/** Internal icon names used only by standard Studio controls and fallbacks. */
export type UiIconName =
  | "actions"
  | "cancel"
  | "delete"
  | "disclosure-collapsed"
  | "disclosure-expanded"
  | "edit"
  | "empty"
  | "executions"
  | "extension"
  | "external-link"
  | "home"
  | "interactive"
  | "key"
  | "loading"
  | "local"
  | "lock"
  | "next"
  | "not-found"
  | "pause"
  | "play"
  | "previous"
  | "refresh"
  | "retry"
  | "save"
  | "sign-out"
  | "success"
  | "table"
  | "warning"
  | "create"
  | "view";

const ICONS: Readonly<Record<UiIconName, SvgIconDefinition>> = {
  actions: fontAwesomeIcon(faEllipsisVertical),
  cancel: fontAwesomeIcon(faXmark),
  create: fontAwesomeIcon(faPlus),
  delete: fontAwesomeIcon(faTrash),
  "disclosure-collapsed": fontAwesomeIcon(faChevronRight),
  "disclosure-expanded": fontAwesomeIcon(faChevronDown),
  edit: fontAwesomeIcon(faPen),
  empty: fontAwesomeIcon(faBoxOpen),
  executions: fontAwesomeIcon(faClockRotateLeft),
  extension: fontAwesomeIcon(faCodeBranch),
  "external-link": fontAwesomeIcon(faUpRightFromSquare),
  home: fontAwesomeIcon(faHouse),
  interactive: fontAwesomeIcon(faPlay),
  key: fontAwesomeIcon(faKey),
  loading: fontAwesomeIcon(faCircleNotch),
  local: fontAwesomeIcon(faGear),
  lock: fontAwesomeIcon(faLock),
  next: fontAwesomeIcon(faChevronRight),
  "not-found": fontAwesomeIcon(faFolderTree),
  pause: fontAwesomeIcon(faPause),
  play: fontAwesomeIcon(faPlay),
  previous: fontAwesomeIcon(faChevronLeft),
  refresh: fontAwesomeIcon(faArrowRotateRight),
  retry: fontAwesomeIcon(faRotateRight),
  save: fontAwesomeIcon(faFloppyDisk),
  "sign-out": fontAwesomeIcon(faArrowRightFromBracket),
  success: fontAwesomeIcon(faCircleCheck),
  table: fontAwesomeIcon(faTable),
  view: fontAwesomeIcon(faEye),
  warning: fontAwesomeIcon(faTriangleExclamation),
};

export interface IconProperties {
  readonly name?: UiIconName;
  readonly icon?: SvgIconDefinition;
  readonly className?: string | undefined;
  /** Accessible labels are only needed when no adjacent text describes the icon. */
  readonly label?: string;
  readonly spin?: boolean;
}

/** Renders one consistently sized icon without exposing the selected icon pack. */
export function Icon({ name, icon, className, label, spin }: IconProperties) {
  const definition = icon ?? (name === undefined ? undefined : ICONS[name]);

  if (definition === undefined) {
    return null;
  }

  return (
    <svg
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      className={["kestrel-icon", spin ? "spinning" : undefined, className]
        .filter(Boolean)
        .join(" ")}
      fill="currentColor"
      role={label === undefined ? undefined : "img"}
      viewBox={definition.viewBox.join(" ")}
      xmlns="http://www.w3.org/2000/svg"
    >
      {definition.paths.map((path, index) => (
        <path
          d={path.d}
          key={index}
          opacity={path.opacity}
        />
      ))}
    </svg>
  );
}

export interface CatalogIconProperties {
  readonly catalog: Readonly<Record<string, SvgIconDefinition>>;
  readonly iconId?: string | undefined;
  readonly fallback: UiIconName;
  readonly className?: string | undefined;
}

/** Resolves a manifest reference while retaining an internal fallback icon. */
export function CatalogIcon({
  catalog,
  iconId,
  fallback,
  className,
}: CatalogIconProperties) {
  const definition = iconId === undefined ? undefined : catalog[iconId];

  return definition === undefined
    ? <Icon className={className} name={fallback} />
    : <Icon className={className} icon={definition} />;
}
