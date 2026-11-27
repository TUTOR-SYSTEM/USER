import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile } from 'passport-google-oauth20';

export type GoogleProfile = {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatar?: string;
};

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    // No made-up credentials in production: a missing value must stop the boot, not ship a fake client.
    if (
      process.env.NODE_ENV === 'production' &&
      (!configService.get<string>('GOOGLE_CLIENT_ID') ||
        !configService.get<string>('GOOGLE_CLIENT_SECRET'))
    ) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in production');
    }
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID') || 'dev-missing-google-client-id',
      clientSecret:
        configService.get<string>('GOOGLE_CLIENT_SECRET') || 'dev-missing-google-client-secret',
      callbackURL:
        configService.get<string>('GOOGLE_CALLBACK_URL') ||
        'http://localhost:8888/auth/google/callback',
      scope: ['email', 'profile'],
    });
  }

  validate(_accessToken: string, _refreshToken: string, profile: Profile): GoogleProfile {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      throw new Error('Google account has no public email');
    }
    // Fail closed: only an explicit `true` lets the email be used to link or create an account.
    const raw = (profile as Profile & { _json?: { email_verified?: boolean } })._json;
    if (raw?.email_verified !== true) {
      throw new Error('Google account email is not verified');
    }

    return {
      googleId: profile.id,
      email,
      firstName: profile.name?.givenName || profile.displayName || 'Google',
      lastName: profile.name?.familyName || 'User',
      avatar: profile.photos?.[0]?.value,
    };
  }
}
