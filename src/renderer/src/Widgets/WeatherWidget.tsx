import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  RiSunFill,
  RiCloudyFill,
  RiShowersFill,
  RiSnowyFill,
  RiThunderstormsFill,
  RiMistFill,
  RiMoonClearFill,
  RiCloseLine,
  RiTempHotLine,
  RiWindyLine,
  RiDropLine
} from 'react-icons/ri'

interface WeatherData {
  city: string
  country: string
  temperature: number
  humidity: number
  windSpeed: number
  isDay: boolean
  condition: string
}

export default function WeatherWidget() {
  const [isVisible, setIsVisible] = useState(false)
  const [weather, setWeather] = useState<WeatherData | null>(null)

  useEffect(() => {
    const handleEvent = (event: any) => {
      setWeather(event.detail)
      setIsVisible(true)
    }
    window.addEventListener('show-weather', handleEvent)
    return () => window.removeEventListener('show-weather', handleEvent)
  }, [])

  if (!isVisible || !weather) return null

  let bgGradient = ''
  let WeatherIcon = RiSunFill
  let iconColor = ''

  if (!weather.isDay) {
    bgGradient = 'from-indigo-950 via-slate-900 to-black'
    WeatherIcon = weather.condition === 'Clear' ? RiMoonClearFill : RiCloudyFill
    iconColor = 'text-indigo-200'
  } else {
    switch (weather.condition) {
      case 'Clear':
        bgGradient = 'from-sky-400 via-blue-400 to-blue-300'
        WeatherIcon = RiSunFill
        iconColor = 'text-yellow-300 drop-shadow-[0_0_30px_rgba(253,224,71,0.8)]'
        break
      case 'Cloudy':
        bgGradient = 'from-slate-400 via-gray-400 to-slate-300'
        WeatherIcon = RiCloudyFill
        iconColor = 'text-white drop-shadow-xl'
        break
      case 'Rain':
        bgGradient = 'from-slate-700 via-slate-600 to-slate-500'
        WeatherIcon = RiShowersFill
        iconColor = 'text-blue-200 drop-shadow-md'
        break
      case 'Snow':
        bgGradient = 'from-slate-200 via-blue-100 to-white'
        WeatherIcon = RiSnowyFill
        iconColor = 'text-white drop-shadow-xl'
        break
      case 'Thunderstorm':
        bgGradient = 'from-slate-900 via-purple-900 to-slate-800'
        WeatherIcon = RiThunderstormsFill
        iconColor = 'text-yellow-400 drop-shadow-[0_0_20px_rgba(250,204,21,0.6)]'
        break
      case 'Haze':
        bgGradient = 'from-stone-400 via-stone-300 to-stone-200'
        WeatherIcon = RiMistFill
        iconColor = 'text-stone-100 opacity-80'
        break
      default:
        bgGradient = 'from-sky-400 to-blue-300'
        WeatherIcon = RiSunFill
    }
  }

  return (
    <div className="fixed inset-0 z-[9050] flex items-center justify-center p-10 bg-black/60 backdrop-blur-2xl animate-in fade-in duration-500">
      <motion.div
        initial={{ scale: 0.85, opacity: 0, y: 30 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.85, opacity: 0, y: 30 }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className={`relative w-full max-w-3xl aspect-2/1 rounded-[2.5rem] overflow-hidden shadow-[0_0_80px_rgba(0,0,0,0.8)] border border-white/20 bg-linear-to-br ${bgGradient} transition-all duration-1000 group`}
      >
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10 mix-blend-overlay pointer-events-none" />
        <div className="absolute inset-0 shadow-[inset_0_0_60px_rgba(0,0,0,0.4)] pointer-events-none" />

        <button
          onClick={() => setIsVisible(false)}
          className="absolute top-6 right-6 z-50 p-3 bg-black/10 hover:bg-black/30 border border-white/10 hover:border-white/30 backdrop-blur-xl rounded-full text-white transition-all transform hover:scale-110"
        >
          <RiCloseLine size={24} />
        </button>

        <motion.div
          animate={{
            y: [0, -15, 0],
            rotate: [0, 2, -2, 0],
            scale: weather.condition === 'Clear' ? [1, 1.05, 1] : 1
          }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute -right-24 -top-24 opacity-90 pointer-events-none"
        >
          <WeatherIcon className={`w-[28rem] h-[28rem] ${iconColor} drop-shadow-[0_20px_50px_rgba(0,0,0,0.5)]`} />
        </motion.div>

        {weather.condition === 'Rain' && (
          <div className="absolute inset-0 opacity-40 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] mix-blend-overlay animate-pulse" />
        )}

        <div className="absolute top-0 left-0 w-full h-full bg-linear-to-b from-transparent via-black/10 to-black/60 pointer-events-none" />

        <div className="absolute inset-0 z-10 p-12 flex flex-col justify-between">
          <div className="flex flex-col items-start relative pb-4">
            <motion.h1 
               initial={{ opacity: 0, x: -20 }}
               animate={{ opacity: 1, x: 0 }}
               transition={{ delay: 0.2, duration: 0.5 }}
               className="text-6xl font-black text-white tracking-tighter drop-shadow-xl"
            >
              {weather.city}
            </motion.h1>
            <motion.div 
               initial={{ opacity: 0, x: -20 }}
               animate={{ opacity: 1, x: 0 }}
               transition={{ delay: 0.3, duration: 0.5 }}
               className="flex items-center gap-3 mt-2"
            >
              <p className="px-3 py-1 bg-white/10 backdrop-blur-md rounded-lg border border-white/20 text-sm text-white font-bold uppercase tracking-[0.2em] shadow-lg">
                {weather.country}
              </p>
              <div className="h-1 w-12 bg-white/30 rounded-full" />
            </motion.div>
          </div>

          <div className="flex items-end justify-between w-full relative z-20">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.5 }}
              className="flex flex-col"
            >
              <span className="text-[10rem] leading-none font-black text-white tracking-tighter drop-shadow-[0_10px_20px_rgba(0,0,0,0.4)]">
                {Math.round(weather.temperature)}°
              </span>
              <span className="text-3xl text-white font-bold uppercase tracking-[0.15em] drop-shadow-md ml-4 -mt-4 opacity-90">
                {weather.condition}
              </span>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.5, duration: 0.5 }}
              className="flex gap-2 bg-black/30 backdrop-blur-2xl border border-white/20 p-2 rounded-3xl shadow-[0_20px_40px_rgba(0,0,0,0.4)]"
            >
              <div className="flex flex-col items-center justify-center p-4 bg-white/5 rounded-2xl border border-white/5 transition-colors hover:bg-white/10">
                <RiWindyLine size={28} className="text-white/90 mb-2 drop-shadow-md" />
                <span className="text-xl text-white font-black tracking-tight">{weather.windSpeed}</span>
                <span className="text-[9px] text-white/50 font-bold tracking-widest mt-1">KM/H</span>
              </div>

              <div className="flex flex-col items-center justify-center p-4 bg-white/5 rounded-2xl border border-white/5 transition-colors hover:bg-white/10 px-6">
                <RiDropLine size={28} className="text-white/90 mb-2 drop-shadow-md" />
                <span className="text-xl text-white font-black tracking-tight">{weather.humidity}%</span>
                <span className="text-[9px] text-white/50 font-bold tracking-widest mt-1">HUMIDITY</span>
              </div>

              <div className="flex flex-col items-center justify-center p-4 bg-white/5 rounded-2xl border border-white/5 transition-colors hover:bg-white/10">
                <RiTempHotLine size={28} className="text-white/90 mb-2 drop-shadow-md" />
                <span className="text-xl text-white font-black tracking-tight">{weather.isDay ? 'DAY' : 'NIGHT'}</span>
                <span className="text-[9px] text-white/50 font-bold tracking-widest mt-1">CYCLE</span>
              </div>
            </motion.div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
