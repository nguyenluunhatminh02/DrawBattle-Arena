'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useGameStore } from '@/lib/store';

interface Profile {
  id: string;
  email: string;
  nickname: string;
  avatar: string | null;
  createdAt: string;
  streak: {
    currentStreak: number;
    longestStreak: number;
    lastPlayedAt: string | null;
  };
  stats: {
    matchesPlayed: number;
    totalScore: number;
  };
}

export default function ProfilePage() {
  const router = useRouter();
  const { token } = useGameStore();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) {
      router.push('/login');
      return;
    }

    fetch('/api/account/profile', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load profile');
        return res.json();
      })
      .then((data) => {
        setProfile(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [token, router]);

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !token) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('avatar', file);

      const res = await fetch('/api/account/avatar', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      setProfile(prev => prev ? { ...prev, avatar: data.avatarUrl } : null);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteAvatar() {
    if (!token || !confirm('Delete avatar?')) return;

    try {
      await fetch('/api/account/avatar', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      setProfile(prev => prev ? { ...prev, avatar: null } : null);
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-destructive">{error || 'Profile not found'}</p>
            <Button onClick={() => router.push('/login')} className="w-full mt-4">
              Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl mx-auto p-4 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-3xl">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="relative">
              {profile.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={profile.avatar}
                  alt={profile.nickname}
                  width={80}
                  height={80}
                  className="rounded-full object-cover"
                />
              ) : (
                <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center text-3xl font-bold text-primary">
                  {profile.nickname.charAt(0).toUpperCase()}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleAvatarUpload}
                className="hidden"
              />
            </div>
            <div className="flex-1">
              <h2 className="text-2xl font-bold">{profile.nickname}</h2>
              <p className="text-muted-foreground">{profile.email}</p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading...' : 'Upload'}
              </Button>
              {profile.avatar && (
                <Button variant="ghost" size="sm" onClick={handleDeleteAvatar}>
                  Delete
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-4">
            <Card>
              <CardContent className="pt-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-primary">{profile.stats.matchesPlayed}</p>
                  <p className="text-sm text-muted-foreground">Matches Played</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-primary">{profile.stats.totalScore}</p>
                  <p className="text-sm text-muted-foreground">Total Score</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Daily Challenge Streak</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center p-4 bg-secondary rounded-lg">
              <p className="text-4xl font-bold">{profile.streak.currentStreak}</p>
              <p className="text-sm text-muted-foreground">Current Streak</p>
            </div>
            <div className="text-center p-4 bg-secondary rounded-lg">
              <p className="text-4xl font-bold">{profile.streak.longestStreak}</p>
              <p className="text-sm text-muted-foreground">Longest Streak</p>
            </div>
          </div>
          {profile.streak.lastPlayedAt && (
            <p className="text-sm text-muted-foreground mt-4 text-center">
              Last played: {new Date(profile.streak.lastPlayedAt).toLocaleDateString()}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={() => router.push('/daily')} className="flex-1">
          Play Daily Challenge
        </Button>
        <Button onClick={() => router.push('/leaderboard')} variant="outline" className="flex-1">
          View Leaderboard
        </Button>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Member since {new Date(profile.createdAt).toLocaleDateString()}
      </p>
    </div>
  );
}