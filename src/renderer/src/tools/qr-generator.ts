interface QRArgs {
  type?: string
  data?: string
  ssid?: string
  password?: string
  encryption?: string
  payee?: string
  payee_name?: string
  amount?: string | number
  name?: string
  phone?: string
  email?: string
}

export const generateQr = async (args: QRArgs): Promise<string> => {
  try {
    const type = (args.type || 'text').toLowerCase()
    let value = ''
    let label = ''

    switch (type) {
      case 'wifi': {
        const enc = (args.encryption || 'WPA').toUpperCase()
        value = `WIFI:T:${enc};S:${args.ssid || ''};P:${args.password || ''};;`
        label = `Wi-Fi: ${args.ssid || '(network)'}`
        break
      }
      case 'upi': {
        const pn = encodeURIComponent(args.payee_name || args.payee || 'Payee')
        const am = args.amount ? `&am=${args.amount}` : ''
        value = `upi://pay?pa=${args.payee || ''}&pn=${pn}${am}&cu=INR`
        label = `UPI: ${args.payee || ''}`
        break
      }
      case 'contact': {
        value = `MECARD:N:${args.name || ''};TEL:${args.phone || ''};EMAIL:${args.email || ''};;`
        label = `Contact: ${args.name || ''}`
        break
      }
      case 'url':
        value = args.data || ''
        label = args.data || 'URL'
        break
      default:
        value = args.data || ''
        label = 'Text'
    }

    if (!value.trim()) return '❌ Cannot generate a QR code with empty content.'

    window.dispatchEvent(new CustomEvent('show-qr', { detail: { value, label, type } }))
    return `✅ QR code generated (${type}) for ${label}. It is now on screen.`
  } catch (err) {
    return `❌ QR generation failed: ${String(err)}`
  }
}
