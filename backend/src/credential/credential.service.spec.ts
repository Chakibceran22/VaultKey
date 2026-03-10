import { Test, TestingModule } from '@nestjs/testing';
import { CredentialService } from './credential.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';

const mockPrisma = {
  credential: {
    create: jest.fn(),
    findMany: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
  },
};

const mockLogger = {
  error: jest.fn(),
};

describe('CredentialService', () => {
  let service: CredentialService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WINSTON_MODULE_NEST_PROVIDER, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<CredentialService>(CredentialService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── createCredential ───────────────────────────────────────────────

  describe('createCredential', () => {
    const dto = { username: 'alice', email: 'alice@test.com', password: '123', domainId: 1 };

    it('should return { success: true } when credential is created', async () => {
      mockPrisma.credential.create.mockResolvedValue({ id: 1, ...dto });

      const result = await service.createCredential(dto);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.credential.create).toHaveBeenCalledWith({
        data: dto,
      });
    });

    it('should return { success: false } when prisma returns null', async () => {
      mockPrisma.credential.create.mockResolvedValue(null);

      const result = await service.createCredential(dto);

      expect(result).toEqual({ success: false });
    });

    it('should throw ConflictException on P2002 (duplicate field)', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['email'] },
      });
      mockPrisma.credential.create.mockRejectedValue(prismaError);

      await expect(service.createCredential(dto)).rejects.toThrow(
        new ConflictException('This email is already in use'),
      );
    });

    it('should throw InternalServerErrorException on unknown error', async () => {
      mockPrisma.credential.create.mockRejectedValue(new Error('DB down'));

      await expect(service.createCredential(dto)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ─── fetchCredentials ────────────────────────────────────────────────

  describe('fetchCredentials', () => {
    it('should return credentials for a domain', async () => {
      const mockCredentials = [{ id: 1, username: 'alice', email: 'a@test.com', password: '123' }];
      mockPrisma.credential.findMany.mockResolvedValue(mockCredentials);

      const result = await service.fetchCredentials(1);

      expect(result).toEqual({ credentials: mockCredentials });
      expect(mockPrisma.credential.findMany).toHaveBeenCalledWith({
        where: { domainId: 1 },
        select: { id: true, username: true, email: true, password: true },
      });
    });

    it('should throw InternalServerErrorException on error', async () => {
      mockPrisma.credential.findMany.mockRejectedValue(new Error('DB down'));

      await expect(service.fetchCredentials(1)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ─── deleteCredential ────────────────────────────────────────────────

  describe('deleteCredential', () => {
    it('should return { success: true } when deleted', async () => {
      mockPrisma.credential.delete.mockResolvedValue({ id: 1 });

      const result = await service.deleteCredential(1);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.credential.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('should return { success: false } when delete returns null', async () => {
      mockPrisma.credential.delete.mockResolvedValue(null);

      const result = await service.deleteCredential(1);

      expect(result).toEqual({ success: false });
    });

    it('should throw InternalServerErrorException on error', async () => {
      mockPrisma.credential.delete.mockRejectedValue(new Error('DB down'));

      await expect(service.deleteCredential(1)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ─── updateCredential ────────────────────────────────────────────────

  describe('updateCredential', () => {
    it('should return { success: true } when updated', async () => {
      mockPrisma.credential.update.mockResolvedValue({ id: 1 });

      const result = await service.updateCredential(1, { username: 'bob' });

      expect(result).toEqual({ success: true });
      expect(mockPrisma.credential.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { username: 'bob' },  // only defined fields are spread
      });
    });

    it('should only spread defined fields', async () => {
      mockPrisma.credential.update.mockResolvedValue({ id: 1 });

      await service.updateCredential(1, { email: 'new@test.com' });

      expect(mockPrisma.credential.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { email: 'new@test.com' },  // no username or password
      });
    });

    it('should throw InternalServerErrorException on error', async () => {
      mockPrisma.credential.update.mockRejectedValue(new Error('DB down'));

      await expect(service.updateCredential(1, { username: 'bob' })).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});