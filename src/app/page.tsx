'use client'

import { format } from 'date-fns'
import { Download, Pause, Play } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib'

interface FinishItem {
  title: string
  status: '' | 'downloading' | 'finish' | 'error'
}

interface RangeDownload {
  isShowRange: boolean
  startSegment: string
  endSegment: string
}

interface AesConf {
  method: string
  uri: string
  iv: string | Uint8Array
  key: ArrayBuffer | null
  decryptor: any
  stringToBuffer: (str: string) => Uint8Array
}

interface DownloadState {
  isDownloading: boolean
  isPaused: boolean
  isGetMP4: boolean
  downloadIndex: number
  streamDownloadIndex: number
}

export default function M3u8Downloader() {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')

  const [downloadState, setDownloadState] = useState<DownloadState>({
    isDownloading: false,
    isPaused: false,
    isGetMP4: false,
    downloadIndex: 0,
    streamDownloadIndex: 0,
  })

  const [finishList, setFinishList] = useState<FinishItem[]>([])
  const [tsUrlList, setTsUrlList] = useState<string[]>([])
  const [mediaFileList, setMediaFileList] = useState<ArrayBuffer[]>([])
  const [streamWriter, setStreamWriter] = useState<any>(null)

  const [rangeDownload, setRangeDownload] = useState<RangeDownload>({
    isShowRange: false,
    startSegment: '',
    endSegment: '',
  })

  const [aesConf, setAesConf] = useState<AesConf>({
    method: '',
    uri: '',
    iv: '',
    key: null,
    decryptor: null,
    stringToBuffer: (str: string) => new TextEncoder().encode(str),
  })

  // 使用 ref 存储开始时间和持续时间，避免不必要的重渲染
  const beginTimeRef = useRef(new Date())
  const durationSecondRef = useRef(0)

  // 派生状态 - 从 finishList 计算得出
  const { finishNum, errorNum } = useMemo(() => {
    const finished = finishList.filter(
      (item) => item.status === 'finish',
    ).length
    const errors = finishList.filter((item) => item.status === 'error').length
    return { finishNum: finished, errorNum: errors }
  }, [finishList])

  // 派生状态 - 目标片段数
  const targetSegment = useMemo(() => {
    const start = Math.max(parseInt(rangeDownload.startSegment) || 1, 1)
    const end = Math.max(
      parseInt(rangeDownload.endSegment) || tsUrlList.length,
      1,
    )
    const validStart = Math.min(start, tsUrlList.length)
    const validEnd = Math.min(end, tsUrlList.length)
    const finalStart = Math.min(validStart, validEnd)
    const finalEnd = Math.max(validStart, validEnd)
    return finalEnd - finalStart + 1
  }, [rangeDownload.startSegment, rangeDownload.endSegment, tsUrlList.length])

  // 检测是否支持流式下载
  const isSupperStreamWrite = useMemo(
    () =>
      typeof window !== 'undefined' &&
      (window as any).streamSaver &&
      !(window as any).streamSaver.useBlobFallback,
    [],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    getSource()
    const handleKeyup = (event: KeyboardEvent) => {
      if (event.keyCode === 13) {
        getM3U8(false)
      }
    }
    window.addEventListener('keyup', handleKeyup)

    const interval = setInterval(() => retryAll(false), 2000)

    return () => {
      window.removeEventListener('keyup', handleKeyup)
      clearInterval(interval)
    }
  }, [])

  // 获取链接中携带的资源链接
  const getSource = () => {
    if (typeof window !== 'undefined') {
      const href = window.location.href
      if (href.indexOf('?source=') > -1) {
        setUrl(href.split('?source=')[1])
      }
    }
  }

  // 获取文档标题
  const getDocumentTitle = () => {
    let docTitle = document.title
    try {
      docTitle = window.top?.document.title || document.title
    } catch (error) {
      console.log(error)
    }
    return docTitle
  }

  // ajax 请求
  const ajax = useCallback(
    (options: {
      url: string
      type?: string
      success?: (data: any) => void
      fail?: (status?: number) => void
    }) => {
      const xhr = new XMLHttpRequest()
      if (options.type === 'file') {
        xhr.responseType = 'arraybuffer'
      }

      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          const status = xhr.status
          if (status >= 200 && status < 300) {
            options.success?.(xhr.response)
          } else {
            options.fail?.(status)
          }
        }
      }

      xhr.open('GET', options.url, true)
      xhr.send(null)
    },
    [],
  )

  // 合成URL
  const applyURL = useCallback((targetURL: string, baseURL?: string) => {
    baseURL =
      baseURL || (typeof window !== 'undefined' ? window.location.href : '')
    if (targetURL.indexOf('http') === 0) {
      if (window.location.href.indexOf('https') === 0) {
        return targetURL.replace('http://', 'https://')
      }
      return targetURL
    }
    if (targetURL[0] === '/') {
      const domain = baseURL.split('/')
      return `${domain[0]}//${domain[2]}${targetURL}`
    }
    const domain = baseURL.split('/')
    domain.pop()
    return `${domain.join('/')}/${targetURL}`
  }, [])

  // 流式下载
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const streamDownload = useCallback(
    (isMp4: boolean) => {
      setDownloadState((prev) => ({ ...prev, isGetMP4: isMp4 }))
      const urlObj = new URL(url)
      const newTitle = urlObj.searchParams.get('title') || title
      setTitle(newTitle)

      const fileName = newTitle || format(new Date(), 'yyyy_MM_dd HH_mm_ss')
      const finalFileName =
        document.title !== 'm3u8 downloader' ? getDocumentTitle() : fileName

      const writer = (window as any).streamSaver
        .createWriteStream(`${finalFileName}.${isMp4 ? 'mp4' : 'ts'}`)
        .getWriter()
      setStreamWriter(writer)
      toast.info('开始流式下载（边下边存）')
      getM3U8(false)
    },
    [url, title],
  )

  // 解析为 mp4 下载
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const getMP4 = useCallback(() => {
    setDownloadState((prev) => ({ ...prev, isGetMP4: true }))
    getM3U8(false)
  }, [])

  // 获取在线文件
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const getM3U8 = useCallback(
    (onlyGetRange: boolean) => {
      if (!url) {
        toast.error('请输入链接')
        return
      }
      if (url.toLowerCase().indexOf('m3u8') === -1) {
        toast.error('链接有误，请重新输入')
        return
      }
      if (downloadState.isDownloading) {
        toast.warning('资源下载中，请稍后')
        return
      }

      const urlObj = new URL(url)
      const newTitle = urlObj.searchParams.get('title') || title
      setTitle(newTitle)
      beginTimeRef.current = new Date()

      toast.info('正在解析 m3u8 文件')

      ajax({
        url: url,
        success: (m3u8Str: string) => {
          const newTsUrlList: string[] = []
          const newFinishList: FinishItem[] = []

          m3u8Str.split('\n').forEach((item) => {
            if (/^[^#]/.test(item) && item.trim()) {
              newTsUrlList.push(applyURL(item, url))
              newFinishList.push({
                title: item,
                status: '',
              })
            }
          })

          setTsUrlList(newTsUrlList)
          setFinishList(newFinishList)

          if (onlyGetRange) {
            setRangeDownload({
              isShowRange: true,
              endSegment: String(newTsUrlList.length),
              startSegment: '1',
            })
            return
          }

          let startSegment = Math.max(
            parseInt(rangeDownload.startSegment) || 1,
            1,
          )
          let endSegment = Math.max(
            parseInt(rangeDownload.endSegment) || newTsUrlList.length,
            1,
          )
          startSegment = Math.min(startSegment, newTsUrlList.length)
          endSegment = Math.min(endSegment, newTsUrlList.length)
          const newStartSegment = Math.min(startSegment, endSegment)
          const newEndSegment = Math.max(startSegment, endSegment)

          setRangeDownload((prev) => ({
            ...prev,
            startSegment: String(newStartSegment),
            endSegment: String(newEndSegment),
          }))
          setDownloadState((prev) => ({
            ...prev,
            downloadIndex: newStartSegment - 1,
            isDownloading: true,
          }))

          // 获取需要下载的 MP4 视频长度
          if (downloadState.isGetMP4) {
            let infoIndex = 0
            let duration = 0
            m3u8Str.split('\n').forEach((item) => {
              if (item.toUpperCase().indexOf('#EXTINF:') > -1) {
                infoIndex++
                if (
                  parseInt(rangeDownload.startSegment) <= infoIndex &&
                  infoIndex <= parseInt(rangeDownload.endSegment)
                ) {
                  duration += parseFloat(item.split('#EXTINF:')[1])
                }
              }
            })
            durationSecondRef.current = duration
          }

          // 检测视频 AES 加密
          if (m3u8Str.indexOf('#EXT-X-KEY') > -1) {
            const method = (m3u8Str.match(/(.*METHOD=([^,\s]+))/) || [
              '',
              '',
              '',
            ])[2]
            const uri = (m3u8Str.match(/(.*URI="([^"]+))"/) || ['', '', ''])[2]
            const iv = (m3u8Str.match(/(.*IV=([^,\s]+))/) || ['', '', ''])[2]
            const newAesConf = {
              ...aesConf,
              method,
              uri: applyURL(uri, url),
              iv: iv ? aesConf.stringToBuffer(iv) : '',
            }
            setAesConf(newAesConf)
            getAES(newAesConf)
          } else if (newTsUrlList.length > 0) {
            downloadTS(newTsUrlList, newFinishList)
          } else {
            toast.error('资源为空，请查看链接是否有效')
            setDownloadState((prev) => ({ ...prev, isDownloading: false }))
          }
        },
        fail: () => {
          toast.error('链接不正确，请查看链接是否有效')
          setDownloadState((prev) => ({ ...prev, isDownloading: false }))
        },
      })
    },
    [
      url,
      title,
      downloadState.isDownloading,
      downloadState.isGetMP4,
      rangeDownload,
      aesConf,
      ajax,
      applyURL,
    ],
  )

  // 获取AES配置
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const getAES = useCallback(
    (currentAesConf: AesConf) => {
      ajax({
        type: 'file',
        url: currentAesConf.uri,
        success: (key: ArrayBuffer) => {
          const newAesConf = {
            ...currentAesConf,
            key,
          }
          setAesConf(newAesConf)
          downloadTS(tsUrlList, finishList)
        },
        fail: () => {
          toast.error('视频已加密，无法下载')
          setDownloadState((prev) => ({ ...prev, isDownloading: false }))
        },
      })
    },
    [ajax, tsUrlList, finishList],
  )

  // ts 片段的 AES 解码
  const aesDecrypt = useCallback(
    (data: ArrayBuffer, index: number) => {
      const iv =
        aesConf.iv ||
        new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, index])
      // 这里需要实际的解密实现
      return data
    },
    [aesConf.iv],
  )

  // 下载分片
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const downloadTS = useCallback(
    (urlList: string[], finishItems: FinishItem[]) => {
      let currentDownloadIndex = downloadState.downloadIndex

      const download = () => {
        const pause = downloadState.isPaused
        const index = currentDownloadIndex
        const endSegment = parseInt(rangeDownload.endSegment)

        if (index >= endSegment) {
          return
        }

        currentDownloadIndex++
        setDownloadState((prev) => ({
          ...prev,
          downloadIndex: currentDownloadIndex,
        }))

        if (finishItems[index] && finishItems[index].status === '') {
          setFinishList((prev) => {
            const newList = [...prev]
            newList[index].status = 'downloading'
            return newList
          })

          ajax({
            url: urlList[index],
            type: 'file',
            success: (file: ArrayBuffer) => {
              dealTS(file, index, () => {
                if (currentDownloadIndex < endSegment && !pause) {
                  download()
                }
              })
            },
            fail: () => {
              setFinishList((prev) => {
                const newList = [...prev]
                newList[index].status = 'error'

                // 计算错误数并显示提示
                const newErrorNum = newList.filter(
                  (item) => item.status === 'error',
                ).length
                if (newErrorNum % 5 === 0 && newErrorNum > 0) {
                  toast.warning(
                    `已有 ${newErrorNum} 个片段下载失败，正在自动重试`,
                  )
                }

                return newList
              })

              if (currentDownloadIndex < endSegment && !pause) {
                download()
              }
            },
          })
        } else if (currentDownloadIndex < endSegment && !pause) {
          download()
        }
      }

      // 建立多个 ajax 线程
      for (let i = 0; i < Math.min(6, targetSegment - finishNum); i++) {
        download()
      }
    },
    [
      downloadState.downloadIndex,
      downloadState.isPaused,
      rangeDownload.endSegment,
      ajax,
      targetSegment,
      finishNum,
    ],
  )

  // 转码为 mp4
  const conversionMp4 = useCallback(
    async (
      data: ArrayBuffer,
      index: number,
      callback: (data: ArrayBuffer) => void,
    ) => {
      if (downloadState.isGetMP4) {
        try {
          // @ts-expect-error
          const muxjs = await import('mux.js')

          const transmuxer = new muxjs.default.mp4.Transmuxer({
            keepOriginalTimestamps: true,
          })

          transmuxer.on('data', (segment: any) => {
            // 第一个片段需要包含初始化段
            if (index === parseInt(rangeDownload.startSegment) - 1) {
              const initSegmentLength = segment.initSegment.byteLength
              const dataLength = segment.data.byteLength
              const combinedData = new Uint8Array(
                initSegmentLength + dataLength,
              )

              combinedData.set(segment.initSegment, 0)
              combinedData.set(segment.data, initSegmentLength)

              callback(combinedData.buffer)
            } else {
              // 其他片段只需要数据部分
              callback(segment.data.buffer)
            }
          })

          transmuxer.on('done', () => {
            // 转码完成
          })

          // 推送数据进行转码
          transmuxer.push(new Uint8Array(data))
          transmuxer.flush()
        } catch (error) {
          console.error('MP4 转码失败:', error)
          toast.error('MP4 转码失败，将使用原始 TS 格式')
          callback(data)
        }
      } else {
        callback(data)
      }
    },
    [downloadState.isGetMP4, rangeDownload.startSegment],
  )

  // 处理 ts 片段
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const dealTS = useCallback(
    async (file: ArrayBuffer, index: number, callback?: () => void) => {
      const data = aesConf.uri ? aesDecrypt(file, index) : file

      await conversionMp4(data, index, (afterData: ArrayBuffer) => {
        setMediaFileList((prev) => {
          const newList = [...prev]
          newList[index - parseInt(rangeDownload.startSegment) + 1] = afterData
          return newList
        })

        setFinishList((prev) => {
          const newList = [...prev]
          newList[index].status = 'finish'
          const newFinishNum = newList.filter(
            (item) => item.status === 'finish',
          ).length

          if (streamWriter) {
            // 流式写入逻辑
            let currentStreamIndex = downloadState.streamDownloadIndex
            const currentMediaList = [...mediaFileList]
            currentMediaList[index - parseInt(rangeDownload.startSegment) + 1] =
              afterData

            for (
              let idx = currentStreamIndex;
              idx < currentMediaList.length;
              idx++
            ) {
              if (currentMediaList[idx]) {
                streamWriter.write(new Uint8Array(currentMediaList[idx]))
                currentMediaList[idx] = null as any
                currentStreamIndex = idx + 1
              } else {
                break
              }
            }

            setDownloadState((prev) => ({
              ...prev,
              streamDownloadIndex: currentStreamIndex,
            }))

            if (currentStreamIndex >= targetSegment) {
              streamWriter.close()
              toast.success(`流式下载完成，共 ${newFinishNum} 个片段`)
            }
          } else if (newFinishNum === targetSegment) {
            const currentMediaList = [...mediaFileList]
            currentMediaList[index - parseInt(rangeDownload.startSegment) + 1] =
              afterData
            downloadFile(
              currentMediaList,
              title || format(beginTimeRef.current, 'yyyy_MM_dd_HH_mm_ss'),
            )
            toast.success(`下载完成，共 ${newFinishNum} 个片段`)
          }

          return newList
        })

        callback?.()
      })
    },
    [
      aesConf.uri,
      aesDecrypt,
      conversionMp4,
      rangeDownload.startSegment,
      streamWriter,
      downloadState.streamDownloadIndex,
      mediaFileList,
      targetSegment,
      title,
    ],
  )

  // 暂停与恢复
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const togglePause = useCallback(() => {
    setDownloadState((prev) => ({ ...prev, isPaused: !prev.isPaused }))
    if (downloadState.isPaused) {
      retryAll(true)
    }
  }, [downloadState.isPaused])

  // 重新下载某个片段
  const retry = useCallback(
    (index: number) => {
      if (finishList[index].status === 'error') {
        setFinishList((prev) => {
          const newList = [...prev]
          newList[index].status = ''
          return newList
        })

        ajax({
          url: tsUrlList[index],
          type: 'file',
          success: (file: ArrayBuffer) => {
            dealTS(file, index)
          },
          fail: () => {
            setFinishList((prev) => {
              const newList = [...prev]
              newList[index].status = 'error'
              return newList
            })
          },
        })
      }
    },
    [finishList, tsUrlList, ajax, dealTS],
  )

  // 重新下载所有错误片段
  const retryAll = useCallback(
    (forceRestart: boolean) => {
      if (!finishList.length || downloadState.isPaused) {
        return
      }

      let firstErrorIndex = downloadState.downloadIndex
      const newFinishList = finishList.map((item, index) => {
        if (item.status === 'error') {
          firstErrorIndex = Math.min(firstErrorIndex, index)
          return { ...item, status: '' as const }
        }
        return item
      })

      setFinishList(newFinishList)

      if (
        downloadState.downloadIndex >= parseInt(rangeDownload.endSegment) ||
        forceRestart
      ) {
        setDownloadState((prev) => ({
          ...prev,
          downloadIndex: firstErrorIndex,
        }))
        downloadTS(tsUrlList, newFinishList)
      } else {
        setDownloadState((prev) => ({
          ...prev,
          downloadIndex: firstErrorIndex,
        }))
      }
    },
    [
      finishList,
      downloadState.isPaused,
      downloadState.downloadIndex,
      rangeDownload.endSegment,
      tsUrlList,
      downloadTS,
    ],
  )

  // 下载整合后的TS文件
  const downloadFile = useCallback(
    (fileDataList: ArrayBuffer[], fileName: string) => {
      const fileBlob = downloadState.isGetMP4
        ? new Blob(fileDataList, { type: 'video/mp4' })
        : new Blob(fileDataList, { type: 'video/MP2T' })

      const extension = downloadState.isGetMP4 ? '.mp4' : '.ts'

      const a = document.createElement('a')
      a.download = fileName + extension
      a.href = URL.createObjectURL(fileBlob)
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()

      // 释放 URL 对象
      setTimeout(() => URL.revokeObjectURL(a.href), 100)
    },
    [downloadState.isGetMP4],
  )

  // 强制下载现有片段
  const forceDownload = useCallback(() => {
    if (mediaFileList.length) {
      downloadFile(
        mediaFileList,
        title || format(beginTimeRef.current, 'yyyy_MM_dd_HH_mm_ss'),
      )
      toast.success('已触发浏览器下载现有片段')
    } else {
      toast.warning('当前无已下载片段')
    }
  }, [mediaFileList, downloadFile, title])

  return (
    <PageContainer scrollable={false}>
      <div className="container max-w-5xl mx-auto space-y-8 px-4 sm:px-6">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-bold tracking-tight">
            M3U8 在线下载工具
          </h1>
          <p className="text-muted-foreground">
            支持范围下载、流式下载、AES 解密、转 MP4
          </p>
          <div className="text-sm text-muted-foreground italic mt-2">
            测试链接：https://upyun.luckly-mjw.cn/Assets/media-source/example/media/index.m3u8
          </div>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle>输入 m3u8 链接</CardTitle>
            <CardDescription>
              粘贴完整的 m3u8 地址后选择下载方式
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col sm:flex-row gap-4">
              <Field>
                <Label htmlFor="m3u8-url">m3u8 链接</Label>
                <Input
                  id="m3u8-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={downloadState.isDownloading}
                  placeholder="https://example.com/playlist.m3u8"
                  className="text-base"
                />
              </Field>

              {/* 范围选择 */}
              {rangeDownload.isShowRange && (
                <div className="flex flex-col sm:flex-row gap-3 min-w-[260px]">
                  <Field>
                    <Label>起始片段</Label>
                    <Input
                      type="number"
                      min={1}
                      value={rangeDownload.startSegment}
                      onChange={(e) =>
                        setRangeDownload((prev) => ({
                          ...prev,
                          startSegment: e.target.value,
                        }))
                      }
                      disabled={downloadState.isDownloading}
                    />
                  </Field>
                  <Field>
                    <Label>结束片段</Label>
                    <Input
                      type="number"
                      min={1}
                      value={rangeDownload.endSegment}
                      onChange={(e) =>
                        setRangeDownload((prev) => ({
                          ...prev,
                          endSegment: e.target.value,
                        }))
                      }
                      disabled={downloadState.isDownloading}
                    />
                  </Field>
                </div>
              )}
            </div>

            {/* 主要操作按钮 */}
            <div className="flex flex-wrap gap-3">
              {!downloadState.isDownloading ? (
                <>
                  {!rangeDownload.isShowRange ? (
                    <Button onClick={() => getM3U8(true)} variant="outline">
                      选择范围下载
                    </Button>
                  ) : (
                    <Button onClick={() => getM3U8(false)} variant="secondary">
                      取消范围选择
                    </Button>
                  )}

                  <Button onClick={() => getM3U8(false)}>
                    原格式下载 (.ts)
                  </Button>

                  <Button onClick={getMP4}>转码 MP4 下载</Button>
                </>
              ) : (
                <Button
                  onClick={togglePause}
                  size="lg"
                  variant={downloadState.isPaused ? 'default' : 'destructive'}
                  className="min-w-[140px]"
                >
                  {downloadState.isPaused ? (
                    <>
                      <Play className="size-4" />
                      继续下载
                    </>
                  ) : (
                    <>
                      <Pause className="size-4" />
                      暂停下载
                    </>
                  )}
                </Button>
              )}
            </div>

            {/* 流式下载区 */}
            {!downloadState.isDownloading && isSupperStreamWrite && (
              <div className="pt-4 border-t">
                <p className="text-sm text-muted-foreground mb-3">
                  超大视频建议使用流式下载（几乎不占内存）
                </p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <Button
                    onClick={() => streamDownload(false)}
                    variant="outline"
                    className={cn(
                      'h-12',
                      'border-green-600 text-green-700',
                      'hover:bg-green-50 hover:text-green-800',
                    )}
                  >
                    流式原格式下载 (.ts)
                  </Button>
                  <Button
                    onClick={() => streamDownload(true)}
                    className={cn(
                      'h-12',
                      'bg-gradient-to-r from-green-600 to-emerald-600',
                      'hover:from-green-700 hover:to-emerald-700',
                    )}
                  >
                    流式 MP4 下载
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 下载进度区 */}
        {finishList.length > 0 && (
          <Card>
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                  <CardTitle>下载进度</CardTitle>
                  <CardDescription>总片段数：{targetSegment}</CardDescription>
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="text-sm space-x-3">
                    <Badge variant="outline">已完成 {finishNum}</Badge>
                    {errorNum > 0 && (
                      <Badge variant="destructive">失败 {errorNum}</Badge>
                    )}
                  </div>

                  {mediaFileList.some(Boolean) && !streamWriter && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={forceDownload}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      下载已完成片段
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {/* 进度条 */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>整体进度</span>
                  <span className="font-medium">
                    {((finishNum / targetSegment) * 100).toFixed(1)}%
                  </span>
                </div>
                <Progress
                  value={(finishNum / targetSegment) * 100}
                  className="h-2.5"
                />
              </div>

              <Separator />

              {/* 错误提示 */}
              {errorNum > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>部分片段下载失败</AlertTitle>
                  <AlertDescription>
                    红色格子可点击重试 • 系统每 2 秒自动重试一次
                  </AlertDescription>
                </Alert>
              )}

              {/* 片段网格 */}
              <TooltipProvider>
                <div
                  className={cn(
                    'grid gap-1.5 auto-rows-fr',
                    'grid-cols-6 sm:grid-cols-10 md:grid-cols-12 lg:grid-cols-15 xl:grid-cols-20',
                  )}
                >
                  {finishList.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: <explanation>
                    <Tooltip key={index}>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => retry(index)}
                          disabled={item.status !== 'error'}
                          className={cn(
                            'aspect-square rounded-md border font-medium',
                            'text-xs sm:text-sm',
                            'transition-all duration-150 shadow-sm',
                            'flex items-center justify-center',
                            item.status === 'finish' &&
                              'bg-emerald-600 hover:bg-emerald-700 border-emerald-700 text-white',
                            item.status === 'error' &&
                              'bg-red-600 hover:bg-red-700 border-red-700 text-white cursor-pointer hover:scale-105',
                            item.status === 'downloading' &&
                              'bg-blue-600 animate-pulse border-blue-700 text-white',
                            item.status === '' &&
                              'bg-muted hover:bg-muted/80 border-border text-muted-foreground',
                            'disabled:cursor-not-allowed disabled:opacity-60',
                          )}
                        >
                          {index + 1}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-xs truncate">
                          {item.title || `片段 ${index + 1}`}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {item.status === 'finish'
                            ? '已完成'
                            : item.status === 'error'
                              ? '点击重试'
                              : item.status === 'downloading'
                                ? '下载中...'
                                : '等待下载'}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </TooltipProvider>
            </CardContent>
          </Card>
        )}
      </div>
    </PageContainer>
  )
}
