// Shared types and utilities for AI CRM

// ============================================================
// Canonical enums (single source of truth across apps)
// ============================================================

/**
 * System-level role assigned to a user account.
 *
 * Canonical definition — both `apps/api` and `apps/web-next` re-export
 * this from their local `types/index.ts` so import sites don't have to
 * change when the union evolves. If you add a new role, do it HERE.
 */
export type UserRole = 'ADMIN' | 'MEMBER' | 'VIEWER';

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

// User types
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'analyst' | 'viewer';
  createdAt: string;
  updatedAt: string;
}

// Deal types
export interface Deal {
  id: string;
  name: string;
  company: string;
  status: 'active' | 'closed' | 'passed' | 'pending';
  sector: string;
  ebitda?: number;
  revenue?: number;
  askingPrice?: number;
  createdAt: string;
  updatedAt: string;
}

// Contact types
export interface Contact {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string;
  type: 'intermediary' | 'seller' | 'advisor' | 'other';
  createdAt: string;
  updatedAt: string;
}

// Utility functions
export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
};

export const formatDate = (date: string | Date): string => {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(date));
};
