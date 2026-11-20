import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface ChallengeMeta {
  challengeId: string;
  status: string;
  expiresAt: string;
  hasReplay: boolean;
  attemptCount: number;
  maxAttempts: number;
}

async function getChallengeInfo(id: string): Promise<ChallengeMeta | null> {
  try {
    const res = await fetch(`${API_URL}/api/challenges/${id}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const info = await getChallengeInfo(id);

  if (!info || info.status === 'EXPIRED') {
    return {
      title: 'Đấu Trường Nét - Thách thức đã hết hạn',
      description: 'Thách thức này không còn hoạt động.',
    };
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3002';
  const challengeUrl = `${baseUrl}/challenge/${id}`;

  return {
    title: 'DrawBattle - Bạn đoán được không?',
    description: `Có ${info.attemptCount}/${info.maxAttempts} lượt đoán. Mở link để xem bức tranh và đoán từ khóa!`,
    openGraph: {
      title: '🎨 DrawBattle - Bạn đoán được không?',
      description: 'Một người bạn đã vẽ một bức tranh bí ẩn. Mở link để xem và đoán từ khóa!',
      url: challengeUrl,
      siteName: 'DrawBattle Arena',
      type: 'website',
      images: [
        {
          url: `${baseUrl}/og/challenge.png`,
          width: 1200,
          height: 630,
          alt: 'DrawBattle Challenge',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: '🎨 DrawBattle - Bạn đoán được không?',
      description: 'Mở link để xem bức tranh và đoán từ khóa!',
      images: [`${baseUrl}/og/challenge.png`],
    },
  };
}

export default function ChallengeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
