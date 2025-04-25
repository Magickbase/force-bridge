import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'sudt' })
@Index(['txHash', 'index', 'direction'], { unique: true })
export class Sudt {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column()
  txHash: string;

  @Column()
  direction: number;

  @Column({ length: 10240 })
  address: string;

  @Column()
  sudtArgs: string;

  @Column()
  index: number;

  @Column()
  amount: string;

  @CreateDateColumn()
  createdAt: string;

  @UpdateDateColumn()
  updatedAt: string;
}
