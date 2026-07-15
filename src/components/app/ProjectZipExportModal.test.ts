import { describe, expect, it } from 'vitest'
import {
  formatProjectZipByteCount,
  getProjectZipExportPresentation,
  type ProjectZipExportStatus,
} from './projectZipExportModal'

function createStatus(overrides: Partial<ProjectZipExportStatus> = {}): ProjectZipExportStatus {
  return {
    phase: 'exporting',
    loaded: 0,
    total: null,
    blob: null,
    fileName: '',
    error: '',
    ...overrides,
  }
}

describe('ProjectZipExportModal', () => {
  it('preserves the exporting presentation and disabled action state', () => {
    const presentation = getProjectZipExportPresentation(
      createStatus({ loaded: 256, total: 1024 }),
      (message) => message,
    )

    expect(presentation).toEqual({
      copy: 'Preparing project ZIP...',
      phaseLabel: 'Exporting',
      progressText: '256 B / 1.0 KB',
      progressWidth: '25%',
      isExporting: true,
      hasDownload: false,
    })
  })

  it('preserves ready file details and enables file actions', () => {
    const presentation = getProjectZipExportPresentation(
      createStatus({
        phase: 'ready',
        loaded: 1536,
        total: 1536,
        blob: new Blob(['zip']),
        fileName: 'workspace.zip',
        error: 'Sharing was blocked',
      }),
      (message) => message,
    )

    expect(presentation).toEqual({
      copy: 'workspace.zip',
      phaseLabel: 'Ready',
      progressText: '1.5 KB / 1.5 KB',
      progressWidth: '100%',
      isExporting: false,
      hasDownload: true,
    })
  })

  it('keeps byte formatting and bounded progress behavior stable', () => {
    const translate = (message: string) => `translated:${message}`

    expect(formatProjectZipByteCount(Number.NaN)).toBe('0 B')
    expect(formatProjectZipByteCount(1024 * 1024)).toBe('1.0 MB')
    expect(getProjectZipExportPresentation(createStatus(), translate)).toMatchObject({
      progressText: 'translated:Preparing...',
      progressWidth: '20%',
      isExporting: true,
      hasDownload: false,
    })
    expect(getProjectZipExportPresentation(createStatus({ loaded: 1, total: 1000 }), translate).progressWidth).toBe('5%')
    expect(getProjectZipExportPresentation(createStatus({ loaded: 2000, total: 1000 }), translate).progressWidth).toBe('100%')
  })
})
