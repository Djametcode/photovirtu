// Shared camera-access helpers. Centralises getUserMedia error mapping so the
// room and capture screens show the same clear Indonesian guidance instead of
// silently failing to a black box.

export type CameraNeed = 'video-only' | 'video-audio'

// Secure-context guard: getUserMedia only exists on https:// or localhost. Over
// a plain-http tunnel the API is missing entirely, which otherwise looks like a
// permanent black box with no prompt.
export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export function cameraErrorMessage(err: unknown): string {
  if (!cameraSupported()) {
    return 'Kamera butuh koneksi aman (HTTPS). Buka lewat alamat https:// lalu coba lagi.'
  }
  const name = (err as { name?: string })?.name ?? ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Izin kamera ditolak. Ketuk ikon kamera/gembok di address bar, izinkan kamera, lalu coba lagi.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Kamera tidak ditemukan. Pastikan perangkat punya kamera depan yang aktif.'
    case 'NotReadableError':
      return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.'
    default:
      return 'Tidak bisa mengakses kamera. Periksa izin lalu coba lagi.'
  }
}
