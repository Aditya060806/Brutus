import { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { FileCode2, ExternalLink, X, Sparkles } from 'lucide-react'

export default function LiveCodingWidget() {
  const [isVisible, setIsVisible] = useState(false)
  const [filename, setFilename] = useState('')
  const [filePath, setFilePath] = useState('')
  const [code, setCode] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  const handleEditorMount = (_editor: any, monaco: any) => {
    monaco.editor.defineTheme('brutus-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [{ token: 'comment', foreground: 'ef4444', fontStyle: 'italic' }],
      colors: { 'editor.background': '#00000000' }
    })
    monaco.editor.setTheme('brutus-dark')
  }

  useEffect(() => {
    const handleStartCoding = async (e: any) => {
      const { prompt, file_name } = e.detail
      setFilename(file_name)
      setCode('// Initializing BRUTUS Neural Forge...\n')
      setIsVisible(true)
      setIsGenerating(true)

      const geminiKey = localStorage.getItem('brutus_custom_api_key') || ''

      if (!geminiKey.trim()) {
        setCode(
          '// ❌ SYSTEM ERROR: Missing Gemini API Key.\n// Please configure it in the Command Center Vault (Settings Tab).'
        )
        setIsGenerating(false)
        return
      }

      setCode('// Initializing BRUTUS Neural Forge...\n')

      const result = await window.electron.ipcRenderer.invoke('start-live-coding', {
        prompt,
        filename: file_name,
        geminiKey
      })

      if (result.success) setFilePath(result.filePath)
      setIsGenerating(false)
    }

    const handleOpenVSCode = () => {
      if (filePath) window.electron.ipcRenderer.invoke('open-in-vscode', filePath)
    }

    const handleCodeChunk = (_e: any, chunkText: string) => {
      setCode((prev) => prev + chunkText)
    }

    window.addEventListener('ai-start-coding', handleStartCoding)
    window.addEventListener('ai-open-vscode', handleOpenVSCode)
    window.electron.ipcRenderer.on('live-code-chunk', handleCodeChunk)

    return () => {
      window.removeEventListener('ai-start-coding', handleStartCoding)
      window.removeEventListener('ai-open-vscode', handleOpenVSCode)
      window.electron.ipcRenderer.removeAllListeners('live-code-chunk')
    }
  }, [filePath])

  if (!isVisible) return null

  return (
    <div className="absolute inset-0 z-999 flex items-center justify-center bg-black/60 backdrop-blur-sm p-10">
      <div className="w-full max-w-4xl h-[70vh] flex flex-col bg-[#0a0a0a] border border-red-500/30 rounded-xl shadow-[0_0_50px_rgba(239,68,68,0.1)] overflow-hidden">
        <div className="h-12 bg-black border-b border-white/5 flex items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Sparkles
              className={`w-4 h-4 ${isGenerating ? 'text-red-400 animate-spin' : 'text-red-500'}`}
            />
            <FileCode2 className="w-4 h-4 text-red-400" />
            <span className="text-sm font-mono text-red-100">{filename || 'Building...'}</span>
          </div>

          <div className="flex items-center gap-3">
            {!isGenerating && filePath && (
              <button
                onClick={() => window.electron.ipcRenderer.invoke('open-in-vscode', filePath)}
                className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded text-xs font-mono text-red-300 transition cursor-pointer"
              >
                <ExternalLink className="w-3 h-3" /> OPEN IN VS CODE
              </button>
            )}
            <button
              onClick={() => setIsVisible(false)}
              className="brutus-close p-1 text-zinc-500 rounded cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 relative pt-4 bg-[#050505]">
          <Editor
            height="100%"
            language={filename.endsWith('.py') ? 'python' : 'typescript'}
            theme="brutus-dark"
            value={code}
            onMount={handleEditorMount}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 14,
              fontFamily: "'Fira Code', monospace"
            }}
          />
        </div>
      </div>
    </div>
  )
}
