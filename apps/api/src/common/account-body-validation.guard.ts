import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { LoginDto, RegisterDto } from '../modules/auth/dto/account.dto';

/**
 * The account module's login/register handlers take inline body types, so
 * Nest's ValidationPipe has no class to validate against. This guard applies
 * the auth DTOs to those routes explicitly. It also strips unknown fields so
 * extra properties cannot reach the service layer.
 */
@Injectable()
export class AccountBodyValidationGuard implements CanActivate {
  private readonly dtoByRoute: Record<string, new () => object> = {
    '/api/account/login': LoginDto,
    '/api/account/register': RegisterDto,
  };

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<{
      method?: string;
      originalUrl?: string;
      route?: { path?: string };
      body?: unknown;
    }>();
    if (request.method !== 'POST') return true;

    const path = request.originalUrl?.split('?')[0] ?? '';
    const dtoClass = this.dtoByRoute[path];
    if (!dtoClass) return true;

    const instance = plainToInstance(dtoClass, request.body ?? {});
    const errors = await validate(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: false,
      stopAtFirstError: false,
    });
    if (errors.length > 0) {
      throw new BadRequestException(this.flatten(errors));
    }
    // Replace the body with the whitelisted instance so handlers cannot see
    // undeclared properties even when forbidNonWhitelisted is disabled.
    request.body = instance;
    return true;
  }

  private flatten(errors: ValidationError[]): string[] {
    const messages: string[] = [];
    for (const error of errors) {
      if (error.children?.length) {
        messages.push(...this.flatten(error.children));
      } else if (error.constraints) {
        messages.push(...Object.values(error.constraints));
      }
    }
    return messages.length > 0 ? messages : ['Invalid request body'];
  }
}
