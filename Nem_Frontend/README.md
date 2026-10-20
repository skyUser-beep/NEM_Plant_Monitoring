# NEM Plant Monitor - Frontend (`Nem_Frontend`)

The browser dashboard of the NEM Plant Monitoring project. It is a single-page application built with React 18 and Vite. It displays machines (assets), live values, monitoring rules, alerts, maintenance logs, application settings, and PLC / OPC UA status.

The frontend communicates with the FastAPI backend (`Nem_Backend`) through the REST API at `/api/v1`. It does not store application data itself.

# Quick Start
# Prerequisites

- Node.js and npm installed.
- The `Nem_Backend` FastAPI server running on port `8000`.

# Installation and Development

```powershell
cd Nem_Frontend
npm install
npm run dev
```

Open the application in your browser:

[http://127.0.0.1:5173/ui/](http://127.0.0.1:5173/ui/)

**Important:** Keep `/ui/` at the end of the development URL.

### Production Build

```powershell
npm run build
npm run preview
```

- `npm run build` creates the production files in `dist/`.
- `npm run preview` runs a local preview of the production build.
- FastAPI can serve the production build under `/ui/` when configured accordingly.
- Vite forwards `/api` requests to `http://127.0.0.1:8000` during development.

# Project Structure

```text
Nem_Frontend/
├── public/
│   └── logo.png
├── scripts/
│   └── add-react-imports.js
├── src/
│   ├── app/
│   │   ├── App.jsx
│   │   └── main.jsx
│   │
│   ├── components/
│   │   └── common/
│   │       ├── Brand.jsx
│   │       ├── GroupedMenu.css
│   │       ├── GroupedMenu.jsx
│   │       ├── Icons.jsx
│   │       ├── Layout.jsx
│   │       └── UI.jsx
│   │
│   ├── features/
│   │   ├── assets/
│   │   │   ├── components/
│   │   │   │   └── AssetTree.jsx
│   │   │   └── pages/
│   │   │       ├── AssetDetail.jsx
│   │   │       └── AssetsIndex.jsx
│   │   │
│   │   ├── configuration/
│   │   │   └── pages/
│   │   │       ├── ConfigSub.jsx
│   │   │       └── Configuration.jsx
│   │   │
│   │   ├── dashboard/
│   │   │   └── pages/
│   │   │       └── Home.jsx
│   │   │
│   │   ├── plc/
│   │   │   ├── components/
│   │   │   │   └── MachineCounters.jsx
│   │   │   ├── pages/
│   │   │   │   └── Plc.jsx
│   │   │   └── styles/
│   │   │       └── Plc.css
│   │   │
│   │   ├── rules/
│   │   │   ├── components/
│   │   │   │   ├── AssignMonitoringRulesModal.jsx
│   │   │   │   ├── AssignMonitoringRulesModal.css
│   │   │   │   ├── PredefinedRulesModal.jsx
│   │   │   │   └── PredefinedRulesModal.css
│   │   │   └── pages/
│   │   │       ├── AlertRules.jsx
│   │   │       └── RuleCreatePage.jsx
│   │   │
│   │   └── settings/
│   │       └── pages/
│   │           ├── Settings.jsx
│   │           └── SettingsSub.jsx
│   │
│   ├── services/
│   │   └── api.js
│   │
│   ├── styles/
│   │   └── global.css
│   │
│   └── utils/
│       ├── config.js
│       └── format.js
│
├── .env
├── .gitignore
├── index.html
├── package.json
├── package-lock.json
├── README.md
└── vite.config.js
```


# Project Files Outside `src/`

| File or Folder | Description |
| `index.html` | The main HTML document containing the root element where React renders the application. It also defines the browser tab title and loads the required fonts and metadata. |
| `package.json` | Contains project metadata, dependencies, and npm scripts such as `dev`, `build`, and `preview`. |
| `package-lock.json` | Locks dependency versions for consistent npm installations. |
| `vite.config.js` | Configures Vite, the `/ui/` base path, and the development proxy for backend API requests. |
| `.env` | Stores frontend environment variables, including the API base URL. Never put private secrets in frontend environment variables. |
| `.gitignore` | Specifies generated files, dependencies, environment files, and other items Git should ignore. |
| `public/logo.png` | The company logo displayed in the application header. |
| `scripts/add-react-imports.js` | Optional helper script for adding React imports to JSX files. Use it only if required by the project. |
| `README.md` | Documents installation, project structure, routes, backend communication, and common development tasks. |

# Core Application Files

# `src/app/`


| `App.jsx` | Defines the application's route table and connects URLs to their respective feature pages. It also uses the shared application layout where configured. |
| `main.jsx` | The application entry point. It mounts React, imports global styles, and configures routing and any application-level providers or error handling. |

# `src/components/common/`


`Layout.jsx` | Provides the common application frame, including the header, navigation, breadcrumbs, sidebar, theme controls, and main content area. |
`Brand.jsx` | Displays the company logo and branding. |
`GroupedMenu.jsx` | Provides grouped navigation menus or menu sections. |
`GroupedMenu.css` | Contains styles specific to the grouped menu component. |
`Icons.jsx` | Contains reusable SVG icons and related visual elements. |
`UI.jsx` | Provides reusable interface components, such as cards, status badges, empty states, and modal dialogs, depending on the implemented exports. |

# `src/services/`

`api.js` | Centralizes HTTP communication with the FastAPI backend. It may expose methods such as `get`, `getAll`, `post`, `put`, `patch`, and `del`, depending on the implementation. |

# `src/utils/`

`config.js` | Stores shared application configuration, such as the brand name, application title, and refresh interval. |
`format.js` | Provides formatting utilities for dates, durations, readings, relative times, and monitoring-rule conditions. |

# `src/styles/`


`global.css` | Contains global styling, theme variables, typography, layout rules, reusable controls, and responsive styles. |

# Feature Modules

The application organizes its main functionality under `src/features/`. Each feature contains its own pages, components, and styles where needed.

# 1. Dashboard — `src/features/dashboard/`

| `pages/Home.jsx` | Displays the plant overview, asset health, alert and warning counts, monitoring coverage, rule status, and active alerts. |

# 2. Assets — `src/features/assets/`

| `components/AssetTree.jsx` | Displays a searchable tree of assets, status indicators, rule counts, and asset navigation controls. |
| `pages/AssetsIndex.jsx` | Handles the assets landing page and navigation to an available asset. |
| `pages/AssetDetail.jsx` | Displays asset status, rule bulk activation/deactivation, predefined-rule assignment and copying, and rule archival or permanent deletion alongside live readings, maintenance, and event history. |
| `components/MaintenancePanel.jsx` | Manages schedules and maintenance records; completed records can be archived then permanently deleted, while jobs and schedules can be permanently deleted unless work is currently in progress. Scheduled deletions require double confirmation. |

# 3. Configuration — `src/features/configuration/`

| `pages/Configuration.jsx` | Displays the main configuration menu. |
| `pages/ConfigSub.jsx` | Handles configuration subsections, such as monitoring rules, rule collections, instruction documents, and configuration import, according to the implemented features. |

# 4. PLC / OPC UA — `src/features/plc/`

| `components/MachineCounters.jsx` | Displays machine counters or related machine statistics. |
| `pages/Plc.jsx` | Provides PLC / OPC UA monitoring, connection status, connection testing, NodeId reading operations, and recent readings where implemented. |
| `styles/Plc.css` | Contains styles specific to the PLC monitoring page. |

# 5. Monitoring Rules — `src/features/rules/`

| `components/AssignMonitoringRulesModal.jsx` | Compatibility wrapper around the predefined-rule assignment workflow. |
| `components/AssignMonitoringRulesModal.css` | Contains styling for the assign-monitoring-rules modal. |
| `components/PredefinedRulesModal.jsx` | Searches, filters, reviews, and assigns eligible predefined rules through the backend. |
| `components/PredefinedRulesModal.css` | Contains styling for the predefined-rules modal. |
| `pages/AlertRules.jsx` | Displays monitoring rules currently in alert or warning states. |
| `pages/RuleCreatePage.jsx` | Creates evaluated numeric usage-threshold rules, recurring maintenance schedules, or planned date/time maintenance jobs through their respective APIs. |

# 6. Settings — `src/features/settings/`

| `pages/Settings.jsx` | Displays the main settings menu. |
| `pages/SettingsSub.jsx` | Handles settings subsections, such as user profile, email, analytics, usage, and backup, where supported by the backend and implementation. |

# Application Routes

The following table describes the intended routes. Confirm the actual paths in `src/app/App.jsx`, because route names depend on the configured React Router definitions.

| URL (after `/ui`) | Feature or Page |

 `/`  Plant dashboard — `features/dashboard/pages/Home.jsx` |
| `/assets` | Asset landing page — `features/assets/pages/AssetsIndex.jsx` |
| `/assets/:id` | Individual asset details — `features/assets/pages/AssetDetail.jsx` |
| `/rules/alert` | Alert rules — `features/rules/pages/AlertRules.jsx` |
| `/rules/warning` | Warning rules — `features/rules/pages/AlertRules.jsx` |
| `/rules/create` | Rule creation page — `features/rules/pages/RuleCreatePage.jsx`, if configured |
| `/configuration` | Configuration menu — `features/configuration/pages/Configuration.jsx` |
| `/configuration/:sub` | Configuration subsection — `features/configuration/pages/ConfigSub.jsx` |
| `/settings` | Settings menu — `features/settings/pages/Settings.jsx` |
| `/settings/:sub` | Settings subsection — `features/settings/pages/SettingsSub.jsx` |
| `/plc` | PLC / OPC UA monitoring — `features/plc/pages/Plc.jsx` |

The application is intended to run under `/ui/`. The Vite `base` setting and React Router `basename` must remain consistent.

# How the Frontend Communicates with the Backend

1. A feature page calls a method exposed by `src/services/api.js`.
2. The API service sends an HTTP request to the configured backend endpoint, typically under `/api/v1`.
3. During development, Vite forwards the request to the FastAPI server at `http://127.0.0.1:8000`.
4. The backend returns JSON data.
5. React stores the response in component state and renders the updated interface.
6. Pages that require live updates may periodically request fresh data.

# Environment Configuration

The `.env` file typically contains:

```env
VITE_API_URL=/api/v1
```

The frontend should use this configured API prefix consistently. Environment variables prefixed with `VITE_` are exposed to browser-side code, so they must not contain secrets.

# Common Development Tasks


Change the company name or application title | `src/utils/config.js` 
Change the company logo | `public/logo.png` 
Change global colours, spacing, or themes | `src/styles/global.css` 
Change shared icons | `src/components/common/Icons.jsx` 
Update API communication | `src/services/api.js` 
Update date, duration, or value formatting | `src/utils/format.js` 
Change PLC-specific styling | `src/features/plc/styles/Plc.css` 
Update dashboard content | `src/features/dashboard/pages/Home.jsx` 
Update asset pages | `src/features/assets/pages/` 
Update monitoring rules | `src/features/rules/` 
Update configuration pages | `src/features/configuration/pages/` 
Update settings pages | `src/features/settings/pages/` 
Add or modify a route | `src/app/App.jsx` 
Update the React entry point or router setup | `src/app/main.jsx` 
Change development server settings or API proxy | `vite.config.js` 

# Troubleshooting

# The application does not open

- Confirm that `npm install` has completed successfully.
- Run `npm run dev` from the `Nem_Frontend` directory.
- Open the exact URL printed by Vite, including `/ui/` when required by the configured base path.
- Check the browser console and terminal for errors.

# API requests fail

- Confirm that the FastAPI backend is running on port `8000`.
- Check that the Vite proxy and `VITE_API_URL` are configured correctly.
- Inspect failed requests in the browser's Developer Tools under the Network tab.
- Confirm that the requested endpoint exists in the backend.

# A page shows a blank screen

- Open Developer Tools with `F12` and check the Console tab.
- Check the Vite terminal for compilation errors.
- Verify that the route exists in `src/app/App.jsx`.
- Verify that all imports use the correct paths after moving files.
- Check that CSS imports and exported component names match their actual files.

# Important Notes

- Keep the Vite `base` configuration and React Router `basename` consistent with `/ui/`.
- Update relative imports whenever files are moved between folders.
- Keep `package.json` and `package-lock.json` synchronized through npm.
- Do not manually edit generated `node_modules/` or `dist/` files.
- Do not commit secrets or sensitive credentials.
- Keep the README updated whenever routes, features, or the folder structure change.
