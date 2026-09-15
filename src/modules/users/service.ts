export interface SerializedUser {
  id: string;
  username: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  coverPhotoUrl: string | null;
  bio: string | null;
  website: string | null;
  role: string;
  createdAt: string;
  followersCount: number;
  followingCount: number;
  isFollowing?: boolean;
  stats: UserStats;
  goal: { year: number; target: number; completed: number };
  favoriteGenres: string[];
  favoriteAuthorIds: string[];
  walletBalance: number;
  twoFactorEnabled: boolean;
  publisherId?: string;
  onboardingCompleted: boolean;
  /** Set for role === 'author': the writer profile this account speaks for. */
  authorId?: string;
}