import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const segments = (await params).path
  // Only allow .png files in expected subdirectories (44, 88, 1024)
  const filePath = segments.join('/')
  if (!/^\d+\/[\w-]+\.png$/.test(filePath)) {
    return new NextResponse(null, { status: 404 })
  }

  const publicDir = path.join(process.cwd(), 'public', 'avatars')
  const fullPath = path.join(publicDir, ...segments)

  // Prevent path traversal
  if (!fullPath.startsWith(publicDir)) {
    return new NextResponse(null, { status: 404 })
  }

  try {
    const data = fs.readFileSync(fullPath)
    return new NextResponse(data, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new NextResponse(null, { status: 404 })
  }
}
