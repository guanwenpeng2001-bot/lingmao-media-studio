import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../api/client';
import { AppRoutes } from '../App';
import { THEME_STORAGE_KEY } from '../lib/theme';
import { AppProvider } from '../state/AppContext';

describe('Dual Theme [data-theme="light" | "dark"] Switching & Persistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    document.documentElement.setAttribute('data-theme', 'light');
    vi.spyOn(api, 'getSession').mockRejectedValue(new Error('unauth'));
    vi.spyOn(api, 'listModels').mockResolvedValue([]);
    vi.spyOn(api, 'listTemplates').mockResolvedValue([]);
  });

  it('toggles data-theme between light and dark and persists to localStorage', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/explore']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );

    const toggleBtn = await screen.findByTestId('theme-toggle');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // Switch to dark
    fireEvent.click(toggleBtn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    // Remount and verify persistence restores dark theme
    unmount();
    render(
      <MemoryRouter initialEntries={['/explore']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // Switch back to light
    fireEvent.click(await screen.findByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});
