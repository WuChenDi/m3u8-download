'use client'

import { useEffect, useState } from 'react'
import { getStreamSaver, setupStreamSaver } from '@/lib/streamSaver'

export function useStreamSaver(middleTransporterUrl = '/mitm.html') {
  const [isLoaded, setIsLoaded] = useState(false)
  const [isSupported, setIsSupported] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      // 检查是否已经加载
      const existing = getStreamSaver()
      if (existing) {
        setIsSupported(!existing.useBlobFallback)
        setIsLoaded(true)
        return
      }

      // 设置 StreamSaver
      const config = setupStreamSaver(middleTransporterUrl)
      setIsSupported(!config.useBlobFallback)
      setIsLoaded(true)

      console.log('StreamSaver 初始化完成:', {
        useBlobFallback: config.useBlobFallback,
        isSupported: !config.useBlobFallback,
      })
    } catch (error) {
      console.error('Failed to setup StreamSaver:', error)
      setIsLoaded(true)
      setIsSupported(false)
    }
  }, [middleTransporterUrl])

  return {
    isLoaded,
    isSupported,
    streamSaver: isLoaded ? getStreamSaver() : null,
  }
}
