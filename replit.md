# Photo Date Rescue

## Overview

Photo Date Rescue (PDR) is a premium desktop application designed to safely fix photo and video dates and filenames after cloud exports, phone transfers, or backups. The application analyzes media files from various sources (folders, ZIP archives, external drives), extracts metadata and date signals from multiple sources (EXIF, video metadata, Google Takeout JSON, Apple metadata, filenames, folder structure), and provides confidence-based recommendations for date corrections.

The application follows a workspace model where users can accumulate multiple sources before applying fixes. It emphasizes a calm, reassuring, professional, and minimal user experience with a lavender-themed design language.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Technology Stack:**
- React with TypeScript for the UI layer
- Vite as the build tool and development server
- Wouter for client-side routing (lightweight alternative to React Router)
- TanStack Query for server state management
- Framer Motion for animations
- Tailwind CSS with custom design tokens for styling

**Component Strategy:**
- Uses shadcn/ui component library with Radix UI primitives
- Custom components (`custom-button.tsx`, `custom-card.tsx`) implement the premium PDR design language
- Design DNA follows specific lavender color palette, typography scale, and interaction patterns

**Page Structure:**
- Home page: Welcome/onboarding screen with option to skip
- Source Selection page: Choose folder, ZIP, or drive sources
- Workspace page: Main working area for analysis and applying fixes

**State Management:**
- React Query for async data fetching
- Local component state for UI interactions
- URL search params for passing source information between pages

### Backend Architecture

**Technology Stack:**
- Express.js server with TypeScript
- Drizzle ORM for database operations
- PostgreSQL as the database (configured via DATABASE_URL)

**Server Structure:**
- `server/index.ts`: Express app setup with middleware
- `server/routes.ts`: API route registration
- `server/storage.ts`: Data access layer with interface abstraction
- `server/vite.ts`: Development server integration with Vite HMR

**API Design:**
- RESTful API endpoints prefixed with `/api`
- Storage interface pattern allows swapping implementations (currently MemStorage, designed for database migration)

### Electron Desktop Integration

**Desktop Application Layer:**
- Electron main process (`electron/main.ts`) manages window lifecycle and IPC
- Preload script (`electron/preload.ts`) exposes safe APIs via contextBridge
- Analysis engine (`electron/analysis-engine.ts`) handles file system operations and metadata extraction

**Analysis Engine Features:**
- EXIF metadata parsing using exif-parser
- ZIP archive extraction with adm-zip
- Multiple filename date pattern recognition
- Confidence scoring based on metadata signal agreement
- Progress reporting via IPC events

**Bridge Pattern:**
- `client/src/lib/electron-bridge.ts` provides unified API for Electron features
- Graceful fallback when not running in Electron environment

### Data Storage

**Database Schema:**
- Users table with UUID primary keys
- Drizzle ORM with PostgreSQL dialect
- Schema defined in `shared/schema.ts` using drizzle-zod for validation

**Current Implementation:**
- MemStorage class for in-memory storage during development
- IStorage interface designed for easy database migration
- Drizzle config points to PostgreSQL but can be extended

### Build System

**Development:**
- Vite dev server on port 5000 with HMR
- TypeScript compilation with path aliases (@/, @shared/, @assets/)
- Electron process compiled separately via `script/build-electron.ts`

**Production:**
- esbuild bundles server code to `dist/index.cjs`
- Vite builds client to `dist/public`
- Selective dependency bundling for optimized cold start

## External Dependencies

### UI Framework
- Radix UI primitives for accessible components
- shadcn/ui component library (new-york style)
- Lucide React for icons

### Database & ORM
- Drizzle ORM with PostgreSQL driver
- drizzle-kit for migrations
- connect-pg-simple for session storage

### File Processing
- exif-parser for EXIF metadata extraction
- adm-zip for ZIP archive handling
- mime-types for file type detection

### Desktop Platform
- Electron for cross-platform desktop app
- IPC for main/renderer process communication

### Development Tools
- Vite with React plugin
- Tailwind CSS v4 with @tailwindcss/vite
- TypeScript with strict mode
- Custom Vite plugins for Replit integration (cartographer, dev-banner, meta-images)